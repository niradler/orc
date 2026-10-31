import { expect, test } from "bun:test";
import { commandShell } from "../lib/command-shell.js";
import type { LaunchDeps } from "../terminals/launch.js";

function deps(overrides: Partial<LaunchDeps>): LaunchDeps {
  return {
    platform: "linux",
    env: {},
    which: () => null,
    isDirectory: () => true,
    home: "/home/test",
    ...overrides,
  };
}

test("should use the host shell and preserve terminal shell overrides", () => {
  expect(commandShell(deps({ env: { SHELL: "/bin/zsh" } }))).toEqual(["/bin/zsh", "-c"]);
  expect(commandShell(deps({ env: {} }))).toEqual(["/bin/bash", "-c"]);
  expect(commandShell(deps({ platform: "darwin", env: {} }))).toEqual(["/bin/zsh", "-l", "-c"]);
  expect(commandShell(deps({ shell: "/custom/bash", env: { SHELL: "/bin/zsh" } }))).toEqual([
    "/custom/bash",
    "-c",
  ]);
});

test("should prefer PowerShell on Windows and preserve configured shell paths", () => {
  const which = (name: string) =>
    name === "pwsh" ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe" : null;
  expect(commandShell(deps({ platform: "win32", which }))).toEqual([
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
  ]);
  expect(commandShell(deps({ platform: "win32", shell: "powershell.exe" }))).toEqual([
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
  ]);
  expect(
    commandShell(deps({ platform: "win32", env: { COMSPEC: "C:\\Windows\\cmd.exe" } })),
  ).toEqual(["C:\\Windows\\cmd.exe", "/d", "/s", "/c"]);
  expect(() => commandShell(deps({ platform: "win32" }))).toThrow("No shell found");
});
