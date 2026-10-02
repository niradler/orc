import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { app, BrowserWindow, dialog, screen, session, shell } from "electron";
import { type Daemon, ensureDaemon } from "./daemon.js";

type OrcConfig = { api?: { port?: number; secret?: string } };

const orcDir = join(homedir(), ".orc");
const configPath = join(orcDir, "config.json");

function readConfig(): OrcConfig {
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as OrcConfig;
  } catch {
    return {};
  }
}

function configuredPort(): number {
  if (process.env.ORC_API_PORT) return Number(process.env.ORC_API_PORT);
  return readConfig().api?.port ?? 7700;
}

function configuredSecret(): string | undefined {
  return process.env.ORC_API_SECRET || readConfig().api?.secret || undefined;
}

function persistSecret(secret: string): void {
  const config = readConfig();
  config.api = { ...config.api, secret };
  mkdirSync(orcDir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function injectSecret(origin: string, secret: string): void {
  const host = new URL(origin).host;
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`http://${host}/*`, `ws://${host}/*`] },
    (details, callback) => {
      callback({
        requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${secret}` },
      });
    },
  );
}

function orcBin(): string {
  if (process.env.ORC_BIN) return process.env.ORC_BIN;
  const exe = process.platform === "win32" ? "orc.exe" : "orc";
  if (app.isPackaged) return join(process.resourcesPath, exe);
  const host =
    process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux";
  const ext = process.platform === "win32" ? ".exe" : "";
  return resolve(import.meta.dirname, "../../cli/dist", `orc-${host}-${process.arch}${ext}`);
}

function isWeb(url: string): boolean {
  return /^https?:/.test(url);
}

const iconPath = resolve(import.meta.dirname, "../build/icon.png");
const statePath = () => join(app.getPath("userData"), "window-state.json");

type WindowState = { x?: number; y?: number; width: number; height: number; maximized: boolean };

function loadWindowState(): WindowState {
  const fallback: WindowState = { width: 1440, height: 900, maximized: false };
  try {
    const saved = JSON.parse(readFileSync(statePath(), "utf-8")) as WindowState;
    if (typeof saved.width !== "number" || typeof saved.height !== "number") return fallback;
    const { x, y, width, height } = saved;
    const onScreen =
      typeof x === "number" &&
      typeof y === "number" &&
      screen.getAllDisplays().some((d) => {
        const b = d.workArea;
        return x < b.x + b.width && x + width > b.x && y < b.y + b.height && y + height > b.y;
      });
    return onScreen ? saved : { ...fallback, width, height, maximized: saved.maximized };
  } catch {
    return fallback;
  }
}

function saveWindowState(w: BrowserWindow): void {
  const state: WindowState = { ...w.getNormalBounds(), maximized: w.isMaximized() };
  try {
    writeFileSync(statePath(), JSON.stringify(state));
  } catch {}
}

let daemon: Daemon | null = null;
let win: BrowserWindow | null = null;
let quitting = false;
let recovering = false;

function openWindow(url: string): void {
  const origin = new URL(url).origin;
  const state = loadWindowState();
  win = new BrowserWindow({
    ...state,
    minWidth: 900,
    minHeight: 600,
    title: "orc",
    backgroundColor: "#0a0d19",
    show: false,
    ...(app.isPackaged ? {} : { icon: iconPath }),
  });
  if (state.maximized) win.maximize();
  win.once("ready-to-show", () => win?.show());
  win.on("close", () => {
    if (win) saveWindowState(win);
  });
  win.on("closed", () => {
    win = null;
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isWeb(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin === origin) return;
    event.preventDefault();
    if (isWeb(target)) void shell.openExternal(target);
  });
  win.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) void recover(`orc is not reachable (${description}).`);
  });
  void win.loadURL(url);
}

async function bringUp(): Promise<Daemon> {
  const configured = configuredSecret();
  const generated = configured ? undefined : randomBytes(24).toString("hex");
  const up = await ensureDaemon({
    port: configuredPort(),
    bin: orcBin(),
    ...(generated ? { secret: generated } : {}),
  });
  if (generated && up.owned) persistSecret(generated);
  const secret = configured ?? (up.owned ? generated : undefined);
  if (secret) injectSecret(up.url, secret);
  up.onExit(() => {
    if (!quitting) void recover("The orc daemon stopped unexpectedly.");
  });
  daemon = up;
  return up;
}

async function recover(reason: string): Promise<void> {
  if (recovering) return;
  recovering = true;
  let message = reason;
  for (;;) {
    console.error(`[orc-desktop] ${message}`);
    const { response } = await dialog.showMessageBox({
      type: "error",
      message,
      buttons: ["Retry", "Quit"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 1) {
      recovering = false;
      app.quit();
      return;
    }
    try {
      const up = await bringUp();
      recovering = false;
      if (win) void win.loadURL(up.url);
      else openWindow(up.url);
      return;
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
  }
}

async function start(): Promise<void> {
  try {
    openWindow((await bringUp()).url);
  } catch (err) {
    dialog.showErrorBox("orc failed to start", err instanceof Error ? err.message : String(err));
    app.quit();
  }
}

app.setName("orc");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (daemon && !win) openWindow(daemon.url);
  });
  app.on("before-quit", () => {
    quitting = true;
    daemon?.stop();
  });
  process.on("SIGINT", () => app.quit());
  process.on("SIGTERM", () => app.quit());
  void app.whenReady().then(() => {
    if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(iconPath);
    return start();
  });
}
