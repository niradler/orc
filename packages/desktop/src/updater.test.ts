import { afterAll, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import {
  UPDATE_INSTALL_CHANNEL,
  UPDATE_STATE_CHANNEL,
  type UpdateSnapshot,
} from "./update-policy.js";

const directory = mkdtempSync(join(tmpdir(), "orc-updater-test-"));
afterAll(() => {
  mock.restore();
  rmSync(directory, { recursive: true, force: true });
});

test("should restore the daemon after an emitted installer failure and report failed recovery", async () => {
  const handlers = new Map<string, (event: { sender: { id: number } }) => unknown>();
  const emitter = new EventEmitter();
  const updater = Object.assign(emitter, {
    setFeedURL: () => {},
    quitAndInstall: () => {
      emitter.emit("error", new Error("Fixture installer failure"));
    },
  });
  mock.module("electron", () => ({
    app: { getVersion: () => "0.1.60", isPackaged: true },
    ipcMain: {
      handle: (channel: string, handler: (event: { sender: { id: number } }) => unknown) =>
        handlers.set(channel, handler),
    },
    Notification: { isSupported: () => false },
  }));
  let initialized = 0;
  mock.module("electron-updater", () => ({
    default: {
      get autoUpdater() {
        initialized++;
        return updater;
      },
    },
  }));
  const { startDesktopUpdates } = await import("./updater.js");
  expect(initialized).toBe(0);
  const settingsPath = join(directory, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ checksEnabled: false }));
  let stopped = false;
  let quitting = false;
  let restored = 0;
  let failRecovery = false;
  const window = {
    isDestroyed: () => false,
    webContents: { id: 7, send: () => {} },
  } as unknown as BrowserWindow;
  const host = {
    getWindow: () => window,
    settingsPath,
    showWindow: () => {},
    stopOwnedDaemon: async () => {
      stopped = true;
      quitting = true;
    },
    restoreOwnedDaemon: async () => {
      quitting = false;
      if (failRecovery) throw new Error("Fixture recovery failure");
      stopped = false;
      restored++;
    },
  };
  startDesktopUpdates(host, "darwin");
  expect(initialized).toBe(0);
  expect(handlers.size).toBe(0);
  expect(emitter.listenerCount("error")).toBe(0);
  startDesktopUpdates(host);
  expect(initialized).toBe(1);
  const event = { sender: { id: 7 } };
  for (const shouldFail of [false, true]) {
    failRecovery = shouldFail;
    emitter.emit("update-downloaded", { version: "0.1.61", releaseNotes: null });
    await handlers.get(UPDATE_INSTALL_CHANNEL)?.(event);
    await new Promise((resolve) => setImmediate(resolve));
    const state = handlers.get(UPDATE_STATE_CHANNEL)?.(event) as UpdateSnapshot;
    expect(quitting).toBe(false);
    expect(state.phase).toBe("error");
    if (shouldFail) expect(state.error).toContain("Restart the app to recover");
    else {
      expect(stopped).toBe(false);
      expect(restored).toBe(1);
      expect(state.error).toContain("Fixture installer failure");
    }
  }
});
