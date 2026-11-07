import { expect, test } from "bun:test";
import type { DesktopUpdateState } from "../../src/lib/desktop-bridge";
import { formatCheckedAt, updateStatusText } from "../../src/lib/desktop-update";

const state = (patch: Partial<DesktopUpdateState>): DesktopUpdateState => ({
  currentVersion: "0.1.60",
  channel: "stable",
  checksEnabled: true,
  phase: "idle",
  availableVersion: null,
  releaseNotes: null,
  progress: null,
  lastCheckedAt: null,
  error: null,
  packaged: true,
  ...patch,
});

test("describes each desktop update phase", () => {
  expect(updateStatusText(state({ phase: "unavailable", packaged: false }))).toBe(
    "Updates run in an installed app.",
  );
  expect(updateStatusText(state({ phase: "downloading", progress: 41.2 }))).toBe(
    "Downloading update… 41%",
  );
  expect(updateStatusText(state({ phase: "downloaded", availableVersion: "0.1.61" }))).toBe(
    "Version 0.1.61 is ready to install.",
  );
  expect(updateStatusText(state({ phase: "current" }))).toBe("This app is up to date.");
  expect(updateStatusText(state({ checksEnabled: false }))).toBe("Automatic checks are off.");
});

test("formats the last update check", () => {
  expect(formatCheckedAt(null)).toBeNull();
  expect(formatCheckedAt("not-a-date")).toBeNull();
  expect(formatCheckedAt("2026-11-07T12:00:00.000Z")).toContain("2026");
});
