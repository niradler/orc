import { describe, expect, test } from "bun:test";
import {
  applyEvent,
  desktopUpdatesSupported,
  initialSnapshot,
  installDownloadedUpdate,
  parseStoredSettings,
  persistUpdateSnapshot,
  plainReleaseNotes,
  preferencesFromUser,
  settingsToStore,
  withAppVersion,
} from "./update-policy.js";

const current = initialSnapshot(
  "0.1.60",
  {
    channel: "stable",
    checksEnabled: true,
    lastCheckedAt: null,
    lastResult: null,
    lastVersion: null,
    lastError: null,
  },
  true,
);

describe("desktop update policy", () => {
  test("offers desktop updates on Windows and Linux while macOS remains outside this feature", () => {
    expect(desktopUpdatesSupported("win32")).toBe(true);
    expect(desktopUpdatesSupported("linux")).toBe(true);
    expect(desktopUpdatesSupported("darwin")).toBe(false);
    expect(desktopUpdatesSupported("freebsd")).toBe(false);
  });

  test("keeps stored preferences unchanged when persistence fails", () => {
    const stored = parseStoredSettings("");
    const changed = applyEvent(current, {
      type: "preferences",
      channel: "preview",
      checksEnabled: false,
    });
    const failed = persistUpdateSnapshot(current, changed, stored, () => {
      throw new Error("Disk full");
    });
    expect(failed.snapshot).toMatchObject({
      channel: "stable",
      checksEnabled: true,
      phase: "error",
    });
    expect(failed.snapshot.error).toContain("could not be saved");
    expect(failed.stored).toBe(stored);
    expect(stored).toMatchObject({ channel: "stable", checksEnabled: true });
    let written = "";
    const committed = persistUpdateSnapshot(current, changed, stored, (text) => {
      written = text;
    });
    expect(JSON.parse(written)).toEqual(committed.stored);
    expect(committed.stored).toMatchObject({ channel: "preview", checksEnabled: false });
  });

  test("prevents an old channel download from installing after a channel switch", async () => {
    const preview = applyEvent(current, {
      type: "preferences",
      channel: "preview",
      checksEnabled: true,
    });
    const downloading = applyEvent(preview, {
      type: "available",
      version: "0.1.61-beta.1",
      notes: null,
    });
    expect(() =>
      applyEvent(downloading, { type: "preferences", channel: "stable", checksEnabled: true }),
    ).toThrow("Wait for the current");
    const ready = applyEvent(downloading, {
      type: "downloaded",
      version: "0.1.61-beta.1",
      notes: null,
    });
    const stable = applyEvent(ready, {
      type: "preferences",
      channel: "stable",
      checksEnabled: false,
    });
    expect(stable).toMatchObject({ channel: "stable", phase: "idle", availableVersion: null });
    const reloaded = initialSnapshot(
      "0.1.60",
      settingsToStore(stable, settingsToStore(ready, parseStoredSettings('{"channel":"preview"}'))),
      true,
    );
    expect(reloaded).toMatchObject({
      channel: "stable",
      availableVersion: null,
      releaseNotes: null,
    });
    let stopped = false;
    await expect(
      installDownloadedUpdate({
        phase: stable.phase,
        stopOwnedDaemon: async () => {
          stopped = true;
        },
        quitAndInstall: () => {},
      }),
    ).rejects.toThrow("No update is ready");
    expect(stopped).toBe(false);
  });

  test("keeps automatic checks on the stable channel until the user changes them", () => {
    expect(parseStoredSettings("")).toMatchObject({ channel: "stable", checksEnabled: true });
    expect(parseStoredSettings('{"channel":"preview","checksEnabled":false}')).toMatchObject({
      channel: "preview",
      checksEnabled: false,
    });
    expect(preferencesFromUser({ channel: "preview", checksEnabled: false })).toEqual({
      channel: "preview",
      checksEnabled: false,
    });
    expect(() => preferencesFromUser({ channel: "nightly", checksEnabled: true })).toThrow(
      "Invalid update channel",
    );
  });

  test("shows the installed app version in the desktop user agent", () => {
    expect(withAppVersion("Mozilla/5.0 Electron/37.2.0", "0.1.60")).toBe(
      "Mozilla/5.0 Electron/37.2.0 orc/0.1.60",
    );
    expect(withAppVersion("Mozilla/5.0 orc/0.1.1 Electron/37.2.0", "0.1.60")).toBe(
      "Mozilla/5.0 Electron/37.2.0 orc/0.1.60",
    );
  });

  test("renders release notes as plain text", () => {
    expect(plainReleaseNotes("<p>Hello <b>there</b></p><script>alert(1)</script>")).toBe(
      "Hello there",
    );
    expect(plainReleaseNotes([{ version: "0.1.61", note: "Fixed the daemon" }])).toBe(
      "Fixed the daemon",
    );
  });

  test("downloads in the background and installs only a finished download", async () => {
    const found = applyEvent(current, {
      type: "available",
      version: "0.1.61",
      notes: "Notes",
    });
    expect(found.phase).toBe("downloading");
    const ready = applyEvent(applyEvent(found, { type: "progress", percent: 40 }), {
      type: "downloaded",
      version: "0.1.61",
      notes: null,
    });
    expect(ready).toMatchObject({ phase: "downloaded", progress: 100, releaseNotes: "Notes" });
    const order: string[] = [];
    await installDownloadedUpdate({
      phase: ready.phase,
      stopOwnedDaemon: async () => {
        order.push("stop");
      },
      quitAndInstall: () => {
        order.push("install");
      },
    });
    expect(order).toEqual(["stop", "install"]);
    await expect(
      installDownloadedUpdate({
        phase: "downloading",
        stopOwnedDaemon: async () => {
          order.push("stop");
        },
        quitAndInstall: () => {
          order.push("install");
        },
      }),
    ).rejects.toThrow("No update is ready to install");
    expect(order).toEqual(["stop", "install"]);
  });

  test("remembers an up-to-date check and hides updates outside an installed app", () => {
    const stored = parseStoredSettings(
      JSON.stringify({ lastResult: "current", lastCheckedAt: "2026-11-07T00:00:00.000Z" }),
    );
    expect(initialSnapshot("0.1.60", stored, true).phase).toBe("current");
    expect(initialSnapshot("0.1.60", stored, false).phase).toBe("unavailable");
  });
});
