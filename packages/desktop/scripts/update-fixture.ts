import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { app, BrowserWindow, dialog, Notification } from "electron";
import electronUpdater from "electron-updater";

process.on("uncaughtException", (error) => {
  console.error(error);
  app.exit(1);
});

// This entry is packaged only by update-smoke.ts, never by the normal desktop build.
const config = JSON.parse(
  readFileSync(
    process.platform === "darwin"
      ? join(process.resourcesPath, "update-fixture.json")
      : new URL("../update-fixture.json", import.meta.url),
    "utf8",
  ),
) as {
  identity: string;
  roots: Record<string, string>;
};
const root = config.roots[process.platform];
if (
  !root ||
  !isAbsolute(root) ||
  !basename(dirname(root)).startsWith("orc-update-e2e-") ||
  !/^orc-update-fixture-[a-f0-9]+$/.test(config.identity) ||
  !existsSync(join(root, "fixture-owned.json")) ||
  JSON.parse(readFileSync(join(root, "fixture-owned.json"), "utf8")).identity !== config.identity
)
  throw new Error("Update fixture ownership could not be verified");
const ports = JSON.parse(readFileSync(join(root, "fixture-owned.json"), "utf8")) as {
  apiPort: number;
  feedPort: number;
  runId: string;
};
if (
  ![ports.apiPort, ports.feedPort].every(
    (port) => Number.isInteger(port) && port > 0 && port < 65536,
  )
)
  throw new Error("Update fixture ports are invalid");
if (!/^[a-f0-9-]{36}$/.test(ports.runId)) throw new Error("Update fixture run is invalid");

const home = join(root, "home");
for (const key of Object.keys(process.env)) {
  if (/^(ORC_|CLAUDE_|CODEX_|OPENAI_|ANTHROPIC_)|(?:TOKEN|SECRET|API_KEY)$/i.test(key))
    delete process.env[key];
}
const env = {
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  TEMP: join(home, "tmp"),
  TMP: join(home, "tmp"),
  TMPDIR: join(home, "tmp"),
  ORC_HOME: join(home, ".orc"),
  ORC_DB_PATH: join(home, ".orc", "orc.db"),
  ORC_KNOWLEDGE_ROOT: join(home, ".orc", "knowledge"),
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  CODEX_HOME: join(home, ".codex"),
  ORC_API_HOST: "127.0.0.1",
  ORC_API_PORT: String(ports.apiPort),
  ORC_E2E_CHAT_MOCK: "1",
  ORC_DESKTOP_SKIP_SYSTEM_SETUP: "1",
};
Object.assign(process.env, env);
for (const path of [
  home,
  env.APPDATA,
  env.LOCALAPPDATA,
  env.XDG_CACHE_HOME,
  join(home, "userdata"),
  env.TEMP,
])
  mkdirSync(path, { recursive: true });
const privateConfig = JSON.parse(readFileSync(join(env.ORC_HOME, "config.json"), "utf8"));
if (typeof privateConfig.api?.secret !== "string" || !privateConfig.api.secret)
  throw new Error("Fixture development authentication is missing");
process.env.ORC_API_SECRET = privateConfig.api.secret;

app.setPath("userData", join(home, "userdata"));
app.setPath("appData", env.APPDATA);
const setName = app.setName.bind(app);
app.setName = () => setName(config.identity);
setName(config.identity);
if (process.platform === "win32") {
  const setModel = app.setAppUserModelId.bind(app);
  app.setAppUserModelId = () => setModel(`dev.orc.${config.identity}`);
}
app.setLoginItemSettings = () => {
  throw new Error("System startup integration is forbidden in the update fixture");
};
app.setAsDefaultProtocolClient = () => {
  throw new Error("Protocol registration is forbidden in the update fixture");
};
BrowserWindow.prototype.show = () => {};
Notification.prototype.show = () => {};
if (process.platform === "linux") app.commandLine.appendSwitch("no-sandbox");

const report = (event: string, details: Record<string, unknown> = {}) => {
  appendFileSync(
    join(root, "events.jsonl"),
    `${JSON.stringify({ event, runId: ports.runId, version: app.getVersion(), pid: process.pid, ...details })}\n`,
  );
};
report("started", { packaged: app.isPackaged, data: env.ORC_HOME });
if (!app.isPackaged) throw new Error("Update acceptance requires a packaged application");

if (process.platform === "darwin") {
  const request = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, options?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/niradler/orc/releases?per_page=100")
        return request(`http://127.0.0.1:${ports.feedPort}/releases.json`, options);
      if (url.startsWith("https://github.com/niradler/orc/releases/download/"))
        return request(`http://127.0.0.1:${ports.feedPort}/${basename(url)}`, options);
      return request(input, options);
    },
    { preconnect: request.preconnect },
  );
} else {
  const { autoUpdater } = electronUpdater;
  const setFeedURL = autoUpdater.setFeedURL.bind(autoUpdater);
  autoUpdater.setFeedURL = () =>
    setFeedURL({ provider: "generic", url: `http://127.0.0.1:${ports.feedPort}` });
  autoUpdater.on("error", (error: Error) => report("update-error", { message: error.message }));
  autoUpdater.on("update-downloaded", () => report("downloaded"));
}

let timer: ReturnType<typeof setInterval> | undefined;
app.on("before-quit", () => clearInterval(timer));
app.on("quit", () => report("exited"));
dialog.showErrorBox = (_title, content) => {
  report("startup-error", { message: content });
  app.quit();
};
dialog.showMessageBox = async () => {
  report("recovery-dialog");
  return { response: 1, checkboxChecked: false };
};
let window: BrowserWindow | undefined;
app.on("browser-window-created", (_event, created) => {
  window = created;
  created.webContents.once("did-finish-load", () => {
    report("window-ready");
  });
});
let busy = false;
timer = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const response = await fetch(
      `http://127.0.0.1:${ports.feedPort}/fixture-control?version=${app.getVersion()}`,
      { headers: { "x-fixture-id": config.identity }, signal: AbortSignal.timeout(2000) },
    );
    const command = await response.text();
    if (command === "quit") app.quit();
    else if (process.platform === "darwin" && window && !window.isDestroyed()) {
      const state = await window.webContents.executeJavaScript("window.orcDesktop.updates.state()");
      if (state.phase === "downloaded") report("downloaded");
      if (state.phase === "error") report("update-error", { message: state.error });
      if (command === "check" || command === "install") {
        report(`requested-${command}`);
        await window.webContents.executeJavaScript(`window.orcDesktop.updates.${command}()`);
      }
    } else if ((command === "check" || command === "install") && window && !window.isDestroyed()) {
      report(`requested-${command}`);
      await window.webContents.executeJavaScript(`window.orcDesktop.updates.${command}()`);
    }
  } catch (error) {
    if (!window?.isDestroyed()) report("control-error", { message: String(error) });
  } finally {
    busy = false;
  }
}, 250);

const main = new URL("main.js", import.meta.url).href;
await import(main);
