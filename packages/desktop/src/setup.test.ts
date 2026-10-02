import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOnPath, ensureOnWindowsUserPath, installCli, setLinuxAutostart } from "./setup.js";

const win = process.platform === "win32";

function fixture(content = "binary-v1") {
  const home = mkdtempSync(join(tmpdir(), "orc-setup-"));
  const bin = join(home, "bundled-orc");
  writeFileSync(bin, content);
  return { home, bin };
}

describe("installCli", () => {
  test("copies the bundled binary to ~/.orc/bin and marks it executable", () => {
    const { home, bin } = fixture();
    const result = installCli({ bin, version: "1.0.0", home });
    expect(result.binDir).toBe(join(home, ".orc", "bin"));
    expect(readFileSync(result.cli, "utf-8")).toBe("binary-v1");
    if (!win) expect(statSync(result.cli).mode & 0o111).not.toBe(0);
  });

  test("is idempotent for the same version and replaces the copy on a new version", () => {
    const { home, bin } = fixture();
    installCli({ bin, version: "1.0.0", home });
    writeFileSync(bin, "binary-v2");
    expect(readFileSync(installCli({ bin, version: "1.0.0", home }).cli, "utf-8")).toBe(
      "binary-v1",
    );
    expect(readFileSync(installCli({ bin, version: "1.1.0", home }).cli, "utf-8")).toBe(
      "binary-v2",
    );
  });
});

describe("ensureOnPath", () => {
  const exportLine = 'export PATH="$HOME/.orc/bin:$PATH"';

  test("zsh: appends one marked block to .zshenv and keeps existing content", () => {
    const { home } = fixture();
    writeFileSync(join(home, ".zshenv"), "export FOO=1");
    expect(ensureOnPath({ home, platform: "darwin", shell: "zsh" })).toEqual([
      join(home, ".zshenv"),
    ]);
    const text = readFileSync(join(home, ".zshenv"), "utf-8");
    expect(text.startsWith("export FOO=1\n")).toBe(true);
    expect(text).toContain(exportLine);
    expect(ensureOnPath({ home, platform: "darwin", shell: "zsh" })).toEqual([]);
    expect(readFileSync(join(home, ".zshenv"), "utf-8")).toBe(text);
  });

  test("bash on Linux: .bashrc is created, .profile only if it already exists", () => {
    const { home } = fixture();
    expect(ensureOnPath({ home, platform: "linux", shell: "bash" })).toEqual([
      join(home, ".bashrc"),
    ]);
    expect(existsSync(join(home, ".profile"))).toBe(false);
    writeFileSync(join(home, ".profile"), "# mine\n");
    const changed = ensureOnPath({ home, platform: "linux", shell: "bash" });
    expect(changed).toEqual([join(home, ".profile")]);
    expect(readFileSync(join(home, ".profile"), "utf-8")).toContain(exportLine);
  });

  test("fish: writes a conf.d snippet", () => {
    const { home } = fixture();
    const [file] = ensureOnPath({ home, platform: "linux", shell: "fish" });
    expect(readFileSync(file as string, "utf-8")).toContain("fish_add_path");
  });

  test("Windows is left to the registry helper", () => {
    const { home } = fixture();
    expect(ensureOnPath({ home, platform: "win32" })).toEqual([]);
  });
});

describe("setLinuxAutostart", () => {
  test("writes and removes the autostart entry", () => {
    const { home } = fixture();
    const file = join(home, ".config", "autostart", "orc.desktop");
    setLinuxAutostart({ enabled: true, exec: "/opt/orc/orc", home });
    expect(readFileSync(file, "utf-8")).toContain('Exec="/opt/orc/orc" --hidden');
    setLinuxAutostart({ enabled: false, exec: "/opt/orc/orc", home });
    expect(existsSync(file)).toBe(false);
  });
});

describe.skipIf(!win)("ensureOnWindowsUserPath", () => {
  const userPath = () =>
    spawnSync(
      "powershell",
      ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','User')"],
      { encoding: "utf-8" },
    ).stdout.trim();

  test("adds the directory to the user PATH once and can be undone", () => {
    const dir = join(tmpdir(), `orc-path-${process.pid}`);
    try {
      expect(ensureOnWindowsUserPath(dir)).toBe(true);
      expect(userPath().split(";")).toContain(dir);
      expect(ensureOnWindowsUserPath(dir)).toBe(false);
    } finally {
      const cleaned = userPath()
        .split(";")
        .filter((entry) => entry !== dir)
        .join(";");
      spawnSync("powershell", [
        "-NoProfile",
        "-Command",
        `[Environment]::SetEnvironmentVariable('Path','${cleaned.replaceAll("'", "''")}','User')`,
      ]);
    }
  });
});
