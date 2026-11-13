import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { configuredApiSecret, globalConfigPath } from "@orc/core/config";
import { daemonHome } from "@orc/core/daemon-runtime";
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  net,
  screen,
  session,
  Tray,
} from "electron";
import { loadDesktopConfig, saveDesktopConnection } from "./connection.js";
import {
  applyConnectionDraft,
  type ConnectionDraft,
  type ConnectionMode,
  type ConnectionSettings,
  headerRecord,
  localConnection,
  mergeHeaders,
  normalizeHeaders,
  normalizeServerUrl,
  normalizeToken,
  parseConnectionDraft,
  publicConnection,
  readConnectionSettings,
  requestOrigin,
  webOrigin,
  writeConnectionSettings,
} from "./connection-settings.js";
import { type Daemon, ensureDaemon } from "./daemon.js";
import { acknowledgeMacInstall } from "./mac-install.js";
import {
  NOTIFY_CHANNEL,
  OPEN_CHANNEL,
  parseNotifyRequest,
  shouldNotifyNatively,
} from "./notify.js";
import { ensureOnPath, ensureOnWindowsUserPath, installCli, setLinuxAutostart } from "./setup.js";
import { withAppVersion } from "./update-policy.js";
import { startDesktopUpdates } from "./updater.js";
import {
  attachDesktopPreview,
  hasUnsavedPreview,
  openDesktopViewer,
  setDesktopPreviewOrigin,
} from "./viewer.js";

const orcDir = daemonHome();
const HIDDEN_FLAG = "--hidden";
const QUIT_FLAG = "--quit";
const CONNECTION_CHANNEL = "orc:connection";
const CONNECTION_SECTION = "/settings?settingsSection=connection";

type WindowTarget = { url: string; origin: string };

let localAuthorization: Record<string, string> = {};

function localOrigin(): string | null {
  return daemon ? webOrigin(daemon.url) : null;
}

function remoteOrigin(): string | null {
  return connection.remote?.url ? webOrigin(connection.remote.url) : null;
}

function remoteHeaders(settings: ConnectionSettings): Record<string, string> {
  const headers = headerRecord(settings.remote?.headers);
  if (settings.remote?.token) headers.authorization = `Bearer ${settings.remote.token}`;
  return headers;
}

/**
 * Credentials belong to the document that initiated the request, not merely to the
 * destination URL. A page can therefore never make the shell attach another server's
 * token to its own requests, even while a navigation is pending or cancelled.
 */
function installRequestHeaders(): void {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (details, callback) => {
      const skip = () => callback({ requestHeaders: details.requestHeaders });
      if (!win || win.isDestroyed() || details.webContentsId !== win.webContents.id) return skip();
      const target = requestOrigin(details.initiatorOrigin, details.url);
      if (!target) return skip();
      const headers =
        target === localOrigin()
          ? localAuthorization
          : target === remoteOrigin()
            ? remoteHeaders(connection)
            : null;
      if (!headers || !Object.keys(headers).length) return skip();
      callback({ requestHeaders: mergeHeaders(details.requestHeaders, headers) });
    },
  );
}

function currentMode(): ConnectionMode {
  const url =
    win && !win.isDestroyed() ? win.webContents.getURL() || windowTarget?.url : windowTarget?.url;
  return url && localOrigin() && webOrigin(url) === localOrigin() ? "local" : "remote";
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

type WindowState = {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
};

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
  const state: WindowState = {
    ...w.getNormalBounds(),
    maximized: w.isMaximized(),
  };
  try {
    writeFileSync(statePath(), JSON.stringify(state));
  } catch {}
}

let daemon: Daemon | null = null;
let win: BrowserWindow | null = null;
let quitting = false;
let recovering = false;
let tray: Tray | null = null;
let trayMenu: Menu | null = null;
let daemonStopped = false;
let connection: ConnectionSettings = localConnection();
let windowTarget: WindowTarget | null = null;

const connectionPath = () => join(app.getPath("userData"), "connection.json");

function targetFor(settings: ConnectionSettings): WindowTarget {
  if (!daemon) throw new Error("The local ORC server is not available.");
  const url = settings.mode === "remote" && settings.remote?.url ? settings.remote.url : daemon.url;
  return { url, origin: new URL(url).origin };
}

function applyTarget(settings: ConnectionSettings): WindowTarget {
  const target = targetFor(settings);
  windowTarget = target;
  return target;
}

/** The integrated browser and file picker exist only in the local dashboard. */
function localWindowActive(): boolean {
  const url =
    win && !win.isDestroyed() ? win.webContents.getURL() || windowTarget?.url : windowTarget?.url;
  return Boolean(url && localOrigin() && webOrigin(url) === localOrigin());
}

function updateLocalActions(): void {
  const enabled = localWindowActive();
  for (const menu of [Menu.getApplicationMenu(), trayMenu]) {
    const item = menu?.getMenuItemById("browser-and-files");
    if (item) item.enabled = enabled;
  }
  if (trayMenu) tray?.setContextMenu(trayMenu);
}

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
    webPreferences: {
      preload: resolve(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // A remote page gets only the connection bridge; preview, updates and native
      // notifications stay exclusive to the local dashboard.
      additionalArguments:
        origin === localOrigin() ? ["--orc-desktop-local", `--orc-desktop-origin=${origin}`] : [],
    },
  });
  const created = win;
  if (state.maximized) win.maximize();
  attachDesktopPreview(win, origin, localOrigin);
  win.webContents.on("did-navigate", (_event, url) => {
    const next = webOrigin(url);
    if (next) setDesktopPreviewOrigin(next);
    updateLocalActions();
  });
  win.webContents.on("will-prevent-unload", (event) => {
    if (!win) return;
    const response = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["Keep editing", "Discard changes"],
      defaultId: 0,
      cancelId: 0,
      message: "Discard unsaved changes?",
      detail: "Your preview drafts will be lost if you reload or quit ORC.",
      noLink: true,
    });
    if (response === 1) event.preventDefault();
    else quitting = false;
  });
  win.on("page-title-updated", (_event, title) => showNeedsYou(title));
  win.on("focus", closeNotifications);
  win.webContents.setUserAgent(withAppVersion(win.webContents.getUserAgent(), app.getVersion()));
  win.once("ready-to-show", () => win?.show());
  win.on("session-end", () => {
    quitting = true;
  });
  win.on("close", (event) => {
    if (!win) return;
    saveWindowState(win);
    if (!quitting && tray) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    if (win === created) win = null;
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isWeb(target)) openDesktopViewer(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin === (windowTarget?.origin ?? origin)) return;
    event.preventDefault();
    if (isWeb(target)) openDesktopViewer(target);
  });
  win.webContents.on("will-redirect", (event, target, _isInPlace, isMainFrame) => {
    if (!isMainFrame || !windowTarget) return;
    if (webOrigin(target) === windowTarget.origin) return;
    event.preventDefault();
    void recover(`orc redirected to an unexpected address (${webOrigin(target) ?? target}).`);
  });
  win.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) void recover(`orc is not reachable (${description}).`);
  });
  void win.loadURL(url);
}

async function bringUp(): Promise<Daemon> {
  const config = loadDesktopConfig();
  const configured = configuredApiSecret(config.api.secret);
  const generated = configured ? undefined : randomBytes(24).toString("hex");
  const up = await ensureDaemon({
    port: config.api.port,
    dbPath: config.db.path,
    configPath: globalConfigPath(),
    version: app.getVersion(),
    bin: orcBin(),
    logFile: join(orcDir, "desktop-daemon.log"),
    secret: configured ?? generated ?? "",
  });
  try {
    saveDesktopConnection(config, up, generated);
  } catch (error) {
    await up.stop();
    throw error;
  }
  const secret = configured ?? (up.owned ? generated : undefined);
  localAuthorization = secret ? { authorization: `Bearer ${secret}` } : {};
  up.onExit(() => {
    if (!quitting) void recover("The orc daemon stopped unexpectedly.");
  });
  daemon = up;
  return up;
}

function loadTarget(target: WindowTarget, open: boolean): void {
  if (win && !win.isDestroyed()) {
    // Recreate the window when the server class changes so a remote document never
    // inherits the local-only preload bridge and the local dashboard keeps it.
    const current = webOrigin(win.webContents.getURL());
    const currentLocal = current !== null && current === localOrigin();
    const nextLocal = target.origin === localOrigin();
    if (currentLocal !== nextLocal) {
      const previous = win;
      saveWindowState(previous);
      win = null;
      previous.destroy();
      openWindow(target.url);
      return;
    }
    void win.loadURL(target.url);
    return;
  }
  if (open) openWindow(target.url);
}

async function recover(reason: string, open = true): Promise<void> {
  if (recovering) return;
  recovering = true;
  let message = reason;
  for (;;) {
    console.error(`[orc-desktop] ${message}`);
    const remote = windowTarget
      ? windowTarget.origin !== localOrigin()
      : connection.mode === "remote";
    const buttons = remote ? ["Retry", "Use local server", "Quit"] : ["Retry", "Quit"];
    const { response } = await dialog.showMessageBox({
      type: "error",
      message,
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
    });
    if (response === buttons.length - 1) {
      quitting = true;
      recovering = false;
      app.quit();
      return;
    }
    try {
      const up = await bringUp();
      // A remote outage is recovered for this window only; the saved target stays remote.
      const localTarget = { url: up.url, origin: new URL(up.url).origin };
      const target = remote && response !== 1 ? applyTarget(connection) : localTarget;
      if (!remote || response === 1) windowTarget = target;
      recovering = false;
      loadTarget(target, open);
      return;
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
  }
}

function showWindow(): void {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else if (windowTarget) {
    openWindow(windowTarget.url);
  } else if (daemon) {
    openWindow(daemon.url);
  }
}

async function leaveCurrentPreview(): Promise<boolean> {
  if (!hasUnsavedPreview()) return true;
  const options = {
    type: "question" as const,
    buttons: ["Keep editing", "Discard and switch"],
    defaultId: 0,
    cancelId: 0,
    message: "Discard unsaved preview changes?",
    detail: "Switching servers closes drafts and unsaved edits in this window.",
  };
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  return response === 1;
}

/** Opens the local dashboard on Connection, where the desktop target is edited. */
async function showConnectionSettings(): Promise<void> {
  if (!daemon) {
    await recover("The local ORC server is not available.");
    return;
  }
  if (!(await leaveCurrentPreview())) return;
  const target = { url: daemon.url, origin: new URL(daemon.url).origin };
  windowTarget = target;
  const url = `${daemon.url}${CONNECTION_SECTION}`;
  loadTarget({ url, origin: target.origin }, true);
  if (win) {
    win.show();
    win.focus();
  }
}

function localSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const frame = event.senderFrame;
  if (!frame || !daemon || !win || win.isDestroyed()) return false;
  if (event.sender.id !== win.webContents.id) return false;
  if (frame !== event.sender.mainFrame) return false;
  const origin = webOrigin(frame.url);
  return origin !== null && origin === localOrigin();
}

async function probeConnection(
  draft: ConnectionDraft,
  current: ConnectionSettings,
): Promise<{ status: "ready" | "sign_in_required"; version: string }> {
  if (draft.mode !== "remote") throw new Error("Choose the remote server first.");
  const url = normalizeServerUrl(draft.url ?? "");
  const headers = headerRecord(normalizeHeaders(draft.headers));
  const token = draft.clear_token
    ? ""
    : normalizeToken(draft.token) ||
      (current.remote?.url === url ? normalizeToken(current.remote?.token) : "");
  if (token) headers.authorization = `Bearer ${token}`;
  const options = {
    headers,
    redirect: "error" as const,
    signal: AbortSignal.timeout(8000),
  };
  let healthResponse: Response;
  try {
    healthResponse = await net.fetch(`${url}/api/health`, options);
  } catch (error) {
    throw new Error(
      error instanceof Error && error.name === "TimeoutError"
        ? "The remote server did not answer in time."
        : `Could not reach ${url}. Check the address and network.`,
    );
  }
  if (!healthResponse.ok) throw new Error(`The server answered HTTP ${healthResponse.status}.`);
  const health = (await healthResponse.json().catch(() => null)) as {
    status?: unknown;
    version?: unknown;
  } | null;
  if (health?.status !== "ok" || typeof health.version !== "string")
    throw new Error("That address is not an ORC server.");
  const access = await net.fetch(`${url}/api/settings`, options).catch(() => null);
  if (access?.status === 401) return { status: "sign_in_required", version: health.version };
  if (!access?.ok)
    throw new Error(
      access ? `ORC answered HTTP ${access.status} while checking access.` : "Access check failed.",
    );
  return { status: "ready", version: health.version };
}

function registerConnectionIpc(): void {
  ipcMain.handle(CONNECTION_CHANNEL, async (event, payload: unknown) => {
    const request = payload as { action?: unknown } | null;
    if (!request || typeof request !== "object") throw new Error("Invalid connection request.");
    if (request.action === "state")
      return publicConnection(connection, localSender(event), currentMode());
    if (request.action === "open-local-settings") {
      await showConnectionSettings();
      return null;
    }
    if (!localSender(event)) throw new Error("Change the server from the local ORC dashboard.");
    if (request.action === "test")
      return probeConnection(parseConnectionDraft(payload), connection);
    if (request.action === "save") {
      if (!(await leaveCurrentPreview())) throw new Error("Connection change cancelled.");
      const next = applyConnectionDraft(parseConnectionDraft(payload), connection);
      writeConnectionSettings(connectionPath(), next);
      connection = next;
      const target = applyTarget(connection);
      loadTarget(target, true);
      return publicConnection(connection, true, currentMode());
    }
    throw new Error("Unknown connection request.");
  });
}

const linuxAutostartFile = join(homedir(), ".config", "autostart", "orc.desktop");

function autostartEnabled(): boolean {
  if (process.platform === "linux") return existsSync(linuxAutostartFile);
  return app.getLoginItemSettings().openAtLogin;
}

function setAutostart(enabled: boolean): void {
  if (process.platform === "linux") {
    setLinuxAutostart({
      enabled,
      exec: process.env.APPIMAGE ?? process.execPath,
    });
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_FLAG] });
}

function showNeedsYou(title: string): void {
  const count = Number(/^\((\d+)\) /.exec(title)?.[1] ?? 0);
  app.setBadgeCount(count);
  tray?.setToolTip(count ? `orc · ${count} unread notification${count === 1 ? "" : "s"}` : "orc");
}

const notifications = new Set<Notification>();

function closeNotifications(): void {
  for (const notification of notifications) notification.close();
  notifications.clear();
}

function listenForNotifications(): void {
  ipcMain.on(NOTIFY_CHANNEL, (event, payload: unknown) => {
    if (!localSender(event) || !win) return;
    const request = parseNotifyRequest(payload);
    if (!request || !Notification.isSupported() || !shouldNotifyNatively(win)) return;
    const notification = new Notification({
      title: request.title,
      body: request.body,
      silent: request.level === "done",
      ...(app.isPackaged ? {} : { icon: iconPath }),
    });
    notifications.add(notification);
    notification.on("close", () => notifications.delete(notification));
    notification.on("click", () => {
      notifications.delete(notification);
      showWindow();
      win?.webContents.send(OPEN_CHANNEL, { path: request.path, id: request.id ?? null });
    });
    notification.show();
  });
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 }));
  tray.setToolTip("orc");
  trayMenu = Menu.buildFromTemplate([
    { label: "Open orc", click: showWindow },
    { label: "Connection…", click: () => void showConnectionSettings() },
    {
      id: "browser-and-files",
      label: "Browser and files",
      click: () => {
        showWindow();
        openDesktopViewer();
      },
    },
    {
      label: "Start at login",
      type: "checkbox",
      checked: autostartEnabled(),
      click: (item) => setAutostart(item.checked),
    },
    { type: "separator" },
    { label: "Quit orc", click: () => app.quit() },
  ]);
  tray.setContextMenu(trayMenu);
  updateLocalActions();
  tray.on("click", showWindow);
}

function firstRunSetup(): void {
  if (!app.isPackaged) return;
  try {
    const systemSetup = !process.env.ORC_DESKTOP_SKIP_SYSTEM_SETUP;
    const marker = join(app.getPath("userData"), "setup.json");
    if (!existsSync(marker) && systemSetup) {
      setAutostart(true);
      writeFileSync(marker, JSON.stringify({ autostart: true }));
    }
    const { binDir } = installCli({ bin: orcBin(), version: app.getVersion() });
    if (process.platform === "win32") {
      if (systemSetup) ensureOnWindowsUserPath(binDir);
    } else {
      ensureOnPath({});
    }
  } catch (err) {
    console.error(
      `[orc-desktop] setup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function hardenSession(): void {
  const allowed = new Set(["clipboard-sanitized-write", "clipboard-read"]);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(allowed.has(permission)),
  );
  session.defaultSession.setPermissionCheckHandler((_contents, permission) =>
    allowed.has(permission),
  );
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}

async function start(): Promise<void> {
  connection = readConnectionSettings(connectionPath());
  hardenSession();
  installRequestHeaders();
  registerConnectionIpc();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
      {
        label: "File",
        submenu: [
          {
            label: "Connection…",
            accelerator: "CmdOrCtrl+,",
            click: () => void showConnectionSettings(),
          },
          {
            label: "Browser and files",
            id: "browser-and-files",
            accelerator: "CmdOrCtrl+Shift+B",
            click: () => {
              showWindow();
              openDesktopViewer();
            },
          },
          { role: "close" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
  listenForNotifications();
  try {
    await bringUp();
  } catch (err) {
    await recover(err instanceof Error ? err.message : String(err), false);
  }
  if (quitting || !daemon) return;
  try {
    firstRunSetup();
    createTray();
    if (process.platform === "darwin" && app.isPackaged)
      acknowledgeMacInstall(resolve(process.execPath, "../../.."), app.getVersion());
    const target = applyTarget(connection);
    updateLocalActions();
    const startHidden =
      process.argv.includes(HIDDEN_FLAG) || app.getLoginItemSettings().wasOpenedAtLogin;
    if (!startHidden) openWindow(target.url);
  } catch (err) {
    dialog.showErrorBox("orc failed to start", err instanceof Error ? err.message : String(err));
    app.quit();
  }
}

app.setName("orc");
app.enableSandbox();
if (process.platform === "win32") app.setAppUserModelId("dev.orc.desktop");
app.setAboutPanelOptions({
  applicationName: "orc",
  applicationVersion: [app.getVersion(), process.env.ORC_BUILD_TAG].filter(Boolean).join("-"),
});

if (!app.requestSingleInstanceLock() || process.argv.includes(QUIT_FLAG)) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (argv.includes(QUIT_FLAG)) app.quit();
    else showWindow();
  });
  app.on("activate", showWindow);
  app.on("window-all-closed", () => {
    if (!tray && process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  // Stop the daemon only after all windows accepted closing their drafts.
  app.on("will-quit", (event) => {
    if (daemon?.owned && !daemonStopped) {
      event.preventDefault();
      daemonStopped = true;
      void Promise.resolve(daemon.stop()).finally(() => app.quit());
    }
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      quitting = true;
      void Promise.resolve(daemon?.stop()).finally(() => app.exit(0));
    });
  }
  void app.whenReady().then(() => {
    if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(iconPath);
    startDesktopUpdates({
      getWindow: () => win,
      isLocalUrl: (url) => {
        const origin = url ? webOrigin(url) : null;
        return origin !== null && origin === localOrigin();
      },
      showWindow,
      settingsPath: join(app.getPath("userData"), "update-settings.json"),
      stopOwnedDaemon: async () => {
        if (hasUnsavedPreview())
          throw new Error("Save or close modified preview files before restarting to update.");
        quitting = true;
        if (daemon?.owned && !daemonStopped) {
          await daemon.stop();
          daemonStopped = true;
        }
      },
      restoreOwnedDaemon: async () => {
        quitting = false;
        if (!daemonStopped) return;
        daemonStopped = false;
        await bringUp();
      },
    });
    return start();
  });
}
