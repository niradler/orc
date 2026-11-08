import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, type BrowserWindow, ipcMain, Notification } from "electron";
import electronUpdater from "electron-updater";
import type { AppUpdaterEvents } from "electron-updater/out/AppUpdater.js";
import { MacUpdater } from "./mac-updater.js";
import { OPEN_CHANNEL, shouldNotifyNatively } from "./notify.js";
import {
  allowsPrerelease,
  applyEvent,
  CHECK_INTERVAL_MS,
  desktopUpdatesSupported,
  initialSnapshot,
  installDownloadedUpdate,
  parseStoredSettings,
  persistUpdateSnapshot,
  plainReleaseNotes,
  preferencesFromUser,
  START_CHECK_DELAY_MS,
  UPDATE_CHECK_CHANNEL,
  UPDATE_EVENT_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_REPOSITORY,
  UPDATE_SET_CHANNEL,
  UPDATE_STATE_CHANNEL,
  type UpdateSnapshot,
  updateErrorMessage,
} from "./update-policy.js";

type UpdateHost = {
  getWindow: () => BrowserWindow | null;
  stopOwnedDaemon: () => Promise<void>;
  restoreOwnedDaemon: () => Promise<void>;
  showWindow: () => void;
  settingsPath: string;
};

export function startDesktopUpdates(host: UpdateHost, platform = process.platform): void {
  if (!desktopUpdatesSupported(platform)) return;
  const autoUpdater =
    platform === "darwin"
      ? new MacUpdater({
          version: app.getVersion(),
          arch: process.arch,
          cache: join(app.getPath("userData"), "mac-update"),
          installedApp: dirname(dirname(dirname(process.execPath))),
          quit: () => app.quit(),
        })
      : electronUpdater.autoUpdater;
  const events: {
    on<K extends keyof AppUpdaterEvents>(event: K, listener: AppUpdaterEvents[K]): unknown;
  } = autoUpdater;
  let stored = parseStoredSettings(readSettings(host.settingsPath) ?? "");
  let snapshot = initialSnapshot(app.getVersion(), stored, app.isPackaged);
  const installError = autoUpdater instanceof MacUpdater ? autoUpdater.installationError() : null;
  if (installError) snapshot = applyEvent(snapshot, { type: "error", message: installError });
  let running: Promise<UpdateSnapshot> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let startup: ReturnType<typeof setTimeout> | null = null;
  let installing = false;

  async function restoreAfterInstallFailure(): Promise<void> {
    if (!installing) return;
    installing = false;
    await host.restoreOwnedDaemon();
  }

  const publish = (next: UpdateSnapshot, persist = false): UpdateSnapshot => {
    if (persist) {
      const result = persistUpdateSnapshot(snapshot, next, stored, (text) =>
        writeFileSync(host.settingsPath, text),
      );
      stored = result.stored;
      next = result.snapshot;
    }
    snapshot = next;
    const window = host.getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(UPDATE_EVENT_CHANNEL, snapshot);
    return snapshot;
  };

  const check = (): Promise<UpdateSnapshot> => {
    if (installing) return Promise.resolve(snapshot);
    if (running) return running;
    running = runCheck().finally(() => {
      running = null;
    });
    return running;
  };

  async function runCheck(): Promise<UpdateSnapshot> {
    if (!app.isPackaged) return publish(applyEvent(snapshot, { type: "unavailable" }));
    publish(applyEvent(snapshot, { type: "checking" }));
    autoUpdater.allowPrerelease = allowsPrerelease(snapshot.channel);
    try {
      await autoUpdater.checkForUpdates();
      return snapshot;
    } catch (error) {
      return publish(
        applyEvent(snapshot, { type: "error", message: updateErrorMessage(error) }),
        true,
      );
    }
  }

  function schedule(): void {
    if (timer) clearInterval(timer);
    if (startup) clearTimeout(startup);
    timer = null;
    startup = null;
    if (!app.isPackaged || !snapshot.checksEnabled) return;
    startup = setTimeout(() => void check(), START_CHECK_DELAY_MS);
    timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
  }

  function ownedWindow(senderId: number): void {
    const window = host.getWindow();
    if (!window || window.isDestroyed() || window.webContents.id !== senderId)
      throw new Error("Update request rejected");
  }

  if (app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = allowsPrerelease(snapshot.channel);
    autoUpdater.setFeedURL({ provider: "github", ...UPDATE_REPOSITORY });
    events.on("update-available", (info) => {
      publish(
        applyEvent(snapshot, {
          type: "available",
          version: info.version,
          notes: plainReleaseNotes(info.releaseNotes),
        }),
      );
    });
    events.on("download-progress", (progress) => {
      publish(applyEvent(snapshot, { type: "progress", percent: progress.percent }));
    });
    events.on("update-downloaded", (info) => {
      const next = publish(
        applyEvent(snapshot, {
          type: "downloaded",
          version: info.version,
          notes: plainReleaseNotes(info.releaseNotes),
        }),
        true,
      );
      notifyReady(host, next);
    });
    events.on("update-not-available", () => {
      publish(applyEvent(snapshot, { type: "current" }), true);
    });
    events.on("error", (error) => {
      publish(applyEvent(snapshot, { type: "error", message: updateErrorMessage(error) }), true);
      void restoreAfterInstallFailure().catch(() => {
        publish(
          applyEvent(snapshot, {
            type: "error",
            message:
              "The update failed and the daemon could not restart. Restart the app to recover.",
          }),
        );
      });
    });
  }

  ipcMain.handle(UPDATE_STATE_CHANNEL, (event) => {
    ownedWindow(event.sender.id);
    return snapshot;
  });
  ipcMain.handle(UPDATE_SET_CHANNEL, (event, payload: unknown) => {
    ownedWindow(event.sender.id);
    if (installing) throw new Error("Wait for update installation to finish");
    const preferences = preferencesFromUser(payload);
    publish(applyEvent(snapshot, { type: "preferences", ...preferences }), true);
    schedule();
    if (snapshot.checksEnabled && app.isPackaged) void check();
    return snapshot;
  });
  ipcMain.handle(UPDATE_CHECK_CHANNEL, (event) => {
    ownedWindow(event.sender.id);
    return check();
  });
  ipcMain.handle(UPDATE_INSTALL_CHANNEL, async (event) => {
    ownedWindow(event.sender.id);
    if (installing) throw new Error("An update installation is already in progress");
    try {
      installing = snapshot.phase === "downloaded";
      if (installing && autoUpdater instanceof MacUpdater) await autoUpdater.prepareInstall();
      await installDownloadedUpdate({
        phase: snapshot.phase,
        stopOwnedDaemon: host.stopOwnedDaemon,
        quitAndInstall: () =>
          autoUpdater instanceof MacUpdater
            ? autoUpdater.quitAndInstall()
            : autoUpdater.quitAndInstall(true, true),
      });
    } catch (error) {
      publish(applyEvent(snapshot, { type: "error", message: updateErrorMessage(error) }), true);
      await restoreAfterInstallFailure();
      throw error;
    }
  });
  schedule();
}

function readSettings(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function notifyReady(host: UpdateHost, state: UpdateSnapshot): void {
  if (!state.availableVersion || !Notification.isSupported()) return;
  const window = host.getWindow();
  if (window && !window.isDestroyed() && !shouldNotifyNatively(window)) return;
  const notification = new Notification({
    title: "Update ready",
    body: `Restart orc to update to ${state.availableVersion}.`,
  });
  notification.on("click", () => {
    host.showWindow();
    const opened = host.getWindow();
    if (opened && !opened.isDestroyed())
      opened.webContents.send(OPEN_CHANNEL, "/settings?settingsSection=about");
  });
  notification.show();
}
