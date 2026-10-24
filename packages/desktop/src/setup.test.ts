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
    Buffer.from(
      spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes([Environment]::GetEnvironmentVariable('Path','User')))",
        ],
        { encoding: "utf-8", timeout: 10000, windowsHide: true },
      ).stdout.trim(),
      "base64",
    ).toString("utf16le");

  test("adds the directory to the user PATH once and can be undone", () => {
    const dir = join(tmpdir(), `orc-path-quoted'-שלום-${process.pid}`);
    const original = userPath();
    try {
      const started = Date.now();
      expect(ensureOnWindowsUserPath(dir)).toBe(true);
      expect(Date.now() - started).toBeLessThan(10000);
      const prefix = original.replace(/;+$/, "");
      expect(userPath()).toBe(prefix ? `${prefix};${dir}` : dir);
      expect(userPath().split(";")).toContain(dir);
      expect(ensureOnWindowsUserPath(dir)).toBe(false);
    } finally {
      const result = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          [
            "$ErrorActionPreference = 'Stop'",
            `$dir = '${dir.replaceAll("'", "''")}'`,
            "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
            "try {",
            "$path = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
            "$updated = (($path -split ';') | Where-Object { $_ -ne $dir }) -join ';'",
            "$key.SetValue('Path', $updated, $key.GetValueKind('Path'))",
            "} finally { $key.Dispose() }",
          ].join("\n"),
        ],
        { timeout: 20000, windowsHide: true },
      );
      expect(result.status).toBe(0);
      expect(userPath().split(";")).not.toContain(dir);
    }
    // Cleanup preserves registry value kind and other entries without a blocking desktop broadcast.
  }, 30_000);
});
