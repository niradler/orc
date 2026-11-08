import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchMacInstall, validateMacBundle } from "./mac-install.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.skipIf(process.platform !== "darwin")(
  "should relaunch the existing app if installation fails before replacement",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "orc-mac-preswap-"));
    roots.push(root);
    const installedApp = join(root, "Existing.app");
    const workspace = join(root, ".Existing.app.orc-update");
    mkdirSync(join(installedApp, "Contents/MacOS"), { recursive: true });
    mkdirSync(join(workspace, "next.app"), { recursive: true });
    writeFileSync(
      join(installedApp, "Contents/MacOS/fixture"),
      '#!/bin/sh\nprintf relaunched > "$0.relaunched"\n',
      { mode: 0o755 },
    );
    symlinkSync(installedApp, join(workspace, "previous.app"));
    const parent = Bun.spawn(["/bin/sleep", "0.1"], { stdout: "ignore", stderr: "ignore" });
    await launchMacInstall({
      installedApp,
      workspace,
      parentPid: parent.pid,
      version: "2.0.0",
      executable: "fixture",
    });
    await parent.exited;
    const deadline = Date.now() + 3000;
    let restarted = false;
    while (Date.now() < deadline) {
      try {
        restarted =
          readFileSync(join(installedApp, "Contents/MacOS/fixture.relaunched"), "utf8") ===
          "relaunched";
      } catch {}
      if (restarted) break;
      await Bun.sleep(100);
    }
    expect(restarted).toBe(true);
  },
);

test.skipIf(process.platform !== "darwin")(
  "should validate a real ad-hoc signed native bundle",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "orc-mac-native-"));
    roots.push(root);
    const bundle = join(root, "Fixture.app");
    mkdirSync(join(bundle, "Contents/MacOS"), { recursive: true });
    execFileSync(
      "/usr/bin/clang",
      [
        "-arch",
        process.arch === "x64" ? "x86_64" : process.arch,
        "-x",
        "c",
        "-",
        "-o",
        join(bundle, "Contents/MacOS/fixture"),
      ],
      { input: "int main(void) { return 0; }", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] },
    );
    writeFileSync(
      join(bundle, "Contents/Info.plist"),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.orc.fixture</string><key>CFBundleShortVersionString</key><string>1.0.0</string><key>CFBundleExecutable</key><string>fixture</string></dict></plist>',
    );
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", bundle], {
      timeout: 10_000,
      stdio: "pipe",
    });
    await validateMacBundle(bundle, "dev.orc.fixture", "1.0.0");
  },
);

test.skipIf(process.platform !== "darwin")(
  "should reject a wrong bundle version and a symlink bundle",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "orc-mac-bundle-"));
    roots.push(root);
    const bundle = join(root, "orc.app");
    mkdirSync(join(bundle, "Contents"), { recursive: true });
    writeFileSync(
      join(bundle, "Contents/Info.plist"),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.orc.desktop</string><key>CFBundleShortVersionString</key><string>0.1.61</string></dict></plist>',
    );
    await expect(validateMacBundle(bundle, "dev.orc.desktop", "99.0.0")).rejects.toThrow("version");
    symlinkSync(bundle, join(root, "linked.app"));
    await expect(
      validateMacBundle(join(root, "linked.app"), "dev.orc.desktop", "0.1.61"),
    ).rejects.toThrow("symbolic");
  },
);

test.skipIf(process.platform !== "darwin")(
  "should restore the prior bundle when the replacement cannot launch",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "orc-mac-rollback-"));
    roots.push(root);
    const installedApp = join(root, "Installed app.app");
    const workspace = join(root, ".Installed app.app.orc-update");
    mkdirSync(installedApp);
    mkdirSync(workspace);
    mkdirSync(join(workspace, "next.app/Contents/MacOS"), { recursive: true });
    writeFileSync(
      join(workspace, "next.app/Contents/Info.plist"),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.orc.crash-fixture</string><key>CFBundleVersion</key><string>2</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>',
    );
    writeFileSync(join(workspace, "next.app/Contents/MacOS/fixture"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    writeFileSync(join(installedApp, "original"), "preserved");
    const parent = Bun.spawn(["/bin/sleep", "0.2"], { stdout: "ignore", stderr: "ignore" });
    await launchMacInstall({
      installedApp,
      workspace,
      parentPid: parent.pid,
      version: "2.0.0",
      executable: "fixture",
    });
    await parent.exited;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        if (readFileSync(join(workspace, "result"), "utf8").trim() === "error") break;
      } catch {}
      await Bun.sleep(100);
    }
    expect(readFileSync(join(installedApp, "original"), "utf8")).toBe("preserved");
    expect(readFileSync(join(workspace, "result"), "utf8").trim()).toBe("error");
    expect(parent.exitCode).toBe(0);
  },
);
