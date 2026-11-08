import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { OrcConfigSchema } from "@orc/core/config";
import { configureTestShell } from "../../scripts/test-shell.js";

function retireHome(home: string): void {
  if (dirname(home) !== realpathSync(tmpdir()) || !basename(home).startsWith("orc-shell-fixture-"))
    throw new Error("Unexpected owned shell-fixture directory");
  rmSync(home, { recursive: true, force: true });
}

function withHome(check: (home: string) => void): void {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "orc-shell-fixture-")));
  try {
    check(home);
  } finally {
    retireHome(home);
  }
}

test("should isolate Windows PowerShell profiles without changing the parent's environment", () => {
  withHome((home) => {
    const parentHome = process.env.USERPROFILE;
    const binary = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    configureTestShell(home, "win32", () => binary);
    const config = JSON.parse(readFileSync(join(home, ".orc/config.json"), "utf8"));
    expect(OrcConfigSchema.parse(config).terminals.shell).toEqual([
      binary,
      "-NoLogo",
      "-NoProfile",
    ]);
    expect(process.env.USERPROFILE).toBe(parentHome);
    expect(() => configureTestShell(home, "win32", () => "another-shell")).toThrow();
    expect(JSON.parse(readFileSync(join(home, ".orc/config.json"), "utf8"))).toEqual(config);
  });
});

test("should support Windows PowerShell fallback and fail closed when PowerShell is missing", () => {
  withHome((home) => {
    configureTestShell(home, "win32", (name) => (name === "powershell" ? "powershell.exe" : null));
    expect(JSON.parse(readFileSync(join(home, ".orc/config.json"), "utf8"))).toEqual({
      terminals: { shell: ["powershell.exe", "-NoLogo", "-NoProfile"] },
    });
  });
  withHome((home) => {
    expect(() => configureTestShell(home, "win32", () => null)).toThrow("require PowerShell");
    expect(existsSync(join(home, ".orc/config.json"))).toBe(false);
  });
});

test("should leave non-Windows shell behavior unchanged", () => {
  withHome((home) => {
    configureTestShell(home, "linux", () => {
      throw new Error("Should not resolve a Windows shell");
    });
    expect(existsSync(join(home, ".orc/config.json"))).toBe(false);
  });
});
