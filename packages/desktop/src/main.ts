import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { app, BrowserWindow, dialog, session, shell } from "electron";
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

let daemon: Daemon | null = null;
let win: BrowserWindow | null = null;

function openWindow(url: string): void {
  const origin = new URL(url).origin;
  win = new BrowserWindow({ width: 1440, height: 900, title: "orc", show: false });
  win.once("ready-to-show", () => win?.show());
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
  void win.loadURL(url);
}

async function start(): Promise<void> {
  try {
    const configured = configuredSecret();
    const generated = configured ? undefined : randomBytes(24).toString("hex");
    daemon = await ensureDaemon({
      port: configuredPort(),
      bin: orcBin(),
      ...(generated ? { secret: generated } : {}),
    });
    if (generated && daemon.owned) persistSecret(generated);
    const secret = configured ?? (daemon.owned ? generated : undefined);
    if (secret) injectSecret(daemon.url, secret);
    openWindow(daemon.url);
  } catch (err) {
    dialog.showErrorBox("orc failed to start", err instanceof Error ? err.message : String(err));
    app.quit();
  }
}

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
  app.on("before-quit", () => daemon?.stop());
  process.on("SIGINT", () => app.quit());
  process.on("SIGTERM", () => app.quit());
  void app.whenReady().then(start);
}
