import { expect, test } from "bun:test";
import { desktopVersions, formatUptime } from "../../src/lib/about";

test("reads the desktop app and Electron versions only inside the desktop shell", () => {
  expect(
    desktopVersions(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) orc/0.1.59 Chrome/138.0.7204.97 Electron/37.2.0 Safari/537.36",
    ),
  ).toEqual({ app: "0.1.59", electron: "37.2.0" });
  expect(
    desktopVersions(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    ),
  ).toBeNull();
});

test("formats uptime at a readable precision", () => {
  expect(formatUptime(59)).toBe("0m");
  expect(formatUptime(3720)).toBe("1h 2m");
  expect(formatUptime(90000)).toBe("1d 1h");
});
