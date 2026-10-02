import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCli, setLinuxAutostart } from "./setup.js";

const win = process.platform === "win32";

function fixture(content = "binary-v1") {
  const home = mkdtempSync(join(tmpdir(), "orc-setup-"));
  const bin = join(home, "bundled-orc");
  writeFileSync(bin, content);
  return { home, bin };
}

describe("installCli", () => {
  test("copies the bundled binary to ~/.orc/bin and links it into ~/.local/bin", () => {
    const { home, bin } = fixture();
    const result = installCli({ bin, version: "1.0.0", home });
    expect(readFileSync(result.cli, "utf-8")).toBe("binary-v1");
    if (win) return;
    expect(statSync(result.cli).mode & 0o111).not.toBe(0);
    const link = join(home, ".local", "bin", "orc");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(link, "utf-8")).toBe("binary-v1");
    expect(result.linked).toBe(true);
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

  test.skipIf(win)("never replaces a foreign orc already in ~/.local/bin", () => {
    const { home, bin } = fixture();
    const link = join(home, ".local", "bin", "orc");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const foreign = join(home, "npm-orc");
    writeFileSync(foreign, "npm");
    symlinkSync(foreign, link);
    const result = installCli({ bin, version: "1.0.0", home });
    expect(result.linked).toBe(false);
    expect(readFileSync(link, "utf-8")).toBe("npm");
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
