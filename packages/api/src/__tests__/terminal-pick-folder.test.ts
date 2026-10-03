import { describe, expect, test } from "bun:test";
import { folderPickerLaunch, readPickedFolder } from "../terminals/pick-folder.js";

const nasty = 'C:\\Projects\\a";calc.exe "x';

describe("folderPickerLaunch", () => {
  test("windows opens the native folder dialog without putting the path on the command line", () => {
    const launch = folderPickerLaunch({
      platform: "win32",
      which: (name) => (name === "powershell" ? "C:\\Windows\\System32\\powershell.exe" : null),
      initial: nasty,
    });
    expect(launch.argv[0]).toBe("C:\\Windows\\System32\\powershell.exe");
    expect(launch.argv).toContain("-STA");
    expect(launch.argv.join("\n")).not.toContain(nasty);
    expect(launch.argv.join("\n")).toContain("FolderBrowserDialog");
    expect(launch.argv.join("\n")).toContain("AutoUpgradeEnabled");
    expect(launch.env.ORC_PICK_INITIAL).toBe(nasty);
  });

  test("a path with a newline is not passed through the environment", () => {
    const launch = folderPickerLaunch({
      platform: "win32",
      which: (name) => (name === "powershell" ? "powershell.exe" : null),
      initial: "C:\\Projects\\bad\nname",
    });
    expect(launch.env.ORC_PICK_INITIAL).toBeUndefined();
  });

  test("macos uses osascript and keeps the path in the environment", () => {
    const launch = folderPickerLaunch({
      platform: "darwin",
      which: (name) => (name === "osascript" ? "/usr/bin/osascript" : null),
      initial: "/Users/me/Projects",
    });
    expect(launch.argv[0]).toBe("/usr/bin/osascript");
    expect(launch.argv.join("\n")).not.toContain("/Users/me/Projects");
    expect(launch.argv.join("\n")).toContain("choose folder");
    expect(launch.env.ORC_PICK_INITIAL).toBe("/Users/me/Projects");
  });

  test("linux uses zenity with the path as its own argument", () => {
    const launch = folderPickerLaunch({
      platform: "linux",
      which: (name) => (name === "zenity" ? "/usr/bin/zenity" : null),
      initial: "/home/me/src",
    });
    expect(launch.argv[0]).toBe("/usr/bin/zenity");
    expect(launch.argv).toContain("--directory");
    expect(launch.argv).toContain("/home/me/src/");
    expect(launch.argv).not.toContain("-c");
  });

  test("linux falls back to kdialog", () => {
    const launch = folderPickerLaunch({
      platform: "linux",
      which: (name) => (name === "kdialog" ? "/usr/bin/kdialog" : null),
      initial: undefined,
    });
    expect(launch.argv[0]).toBe("/usr/bin/kdialog");
    expect(launch.argv).toContain("--getexistingdirectory");
  });

  test("a machine with no folder dialog reports that", () => {
    expect(() =>
      folderPickerLaunch({ platform: "linux", which: () => null, initial: undefined }),
    ).toThrow(/folder picker/);
  });
});

describe("readPickedFolder", () => {
  test("a chosen path is returned", () => {
    expect(readPickedFolder(0, "C:\\Projects\\orc\r\n", "")).toBe("C:\\Projects\\orc");
  });

  test("cancel is an empty result", () => {
    expect(readPickedFolder(0, "", "")).toBeNull();
    expect(readPickedFolder(1, " \n", "")).toBeNull();
  });

  test("a dialog crash is an error", () => {
    expect(() => readPickedFolder(1, "", "The dialog failed to open")).toThrow(
      /dialog failed to open/,
    );
  });
});
