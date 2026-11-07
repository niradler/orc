import { describe, expect, test } from "bun:test";
import {
  applyEvent,
  initialSnapshot,
  installDownloadedUpdate,
  parseStoredSettings,
  plainReleaseNotes,
  preferencesFromUser,
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
