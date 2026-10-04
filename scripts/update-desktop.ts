import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "./release-lib.js";

export async function installDesktop(options: {
  version: string;
  installer: string;
}): Promise<void> {
  const { version, installer } = options;
  let executable: string;
  let binary: string;
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (!local) throw new Error("LOCALAPPDATA is missing");
    const candidates = [
      join(local, "Programs/@orcdesktop/orc.exe"),
      join(local, "Programs/orc/orc.exe"),
    ];
    executable = process.env.ORC_DESKTOP_PATH ?? candidates.find(existsSync) ?? candidates[0] ?? "";
    if (existsSync(executable)) run(executable, ["--quit"], { timeout: 30_000 });
    run(installer, ["/S", `/D=${dirname(executable)}`], { timeout: 5 * 60_000 });
    binary = join(dirname(executable), "resources/orc.exe");
    const productVersion = run(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "(Get-Item -LiteralPath $env:ORC_RELEASE_APP).VersionInfo.ProductVersion",
      ],
      {
        capture: true,
        timeout: 30_000,
        env: { ORC_RELEASE_APP: executable },
      },
    );
    if (productVersion !== version && productVersion !== `${version}.0`)
      throw new Error(`Installed desktop version differs: ${productVersion}`);
  } else if (process.platform === "darwin") {
    executable = process.env.ORC_DESKTOP_PATH ?? "/Applications/orc.app/Contents/MacOS/orc";
    const app = dirname(dirname(dirname(executable)));
    if (existsSync(executable)) run(executable, ["--quit"], { timeout: 30_000 });
    const mount = join(homedir(), ".orc", `release-mount-${version}`);
    mkdirSync(mount, { recursive: true });
    run("hdiutil", ["attach", installer, "-nobrowse", "-mountpoint", mount], { timeout: 60_000 });
    try {
      if (existsSync(app)) run("ditto", [app, `${app}.before-${version}`], { timeout: 120_000 });
      run("ditto", [join(mount, "orc.app"), app], { timeout: 120_000 });
    } finally {
      run("hdiutil", ["detach", mount], { timeout: 30_000 });
    }
    const installedVersion = run(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleShortVersionString", join(app, "Contents/Info.plist")],
      { capture: true, timeout: 30_000 },
    );
    if (installedVersion !== version)
      throw new Error(`Installed desktop version differs: ${installedVersion}`);
    binary = join(app, "Contents/Resources/orc");
  } else {
    executable = process.env.ORC_DESKTOP_PATH ?? join(homedir(), ".local/bin/orc-desktop.AppImage");
    mkdirSync(dirname(executable), { recursive: true });
    if (existsSync(executable)) {
      run(executable, ["--quit"], { timeout: 30_000 });
      copyFileSync(executable, `${executable}.before-${version}`);
    }
    copyFileSync(installer, executable);
    run("chmod", ["+x", executable], { timeout: 30_000 });
    // The exact AppImage was smoke-tested before publication. Its bundled CLI
    // is verified through desktop setup after relaunch below.
    binary = join(homedir(), ".orc/bin/orc");
  }
  if (!existsSync(executable)) throw new Error(`Installed app not found: ${executable}`);
  const launch = Bun.spawn([executable, "--hidden"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  });
  launch.unref();
  const deadline = Date.now() + 60_000;
  let verified = false;
  while (Date.now() < deadline) {
    if (existsSync(binary)) {
      const installed = run(binary, ["--version"], { capture: true, timeout: 10_000 });
      const installedCli = join(
        homedir(),
        ".orc/bin",
        process.platform === "win32" ? "orc.exe" : "orc",
      );
      if (
        installed === version &&
        existsSync(installedCli) &&
        run(installedCli, ["--version"], { capture: true, timeout: 10_000 }) === version
      ) {
        verified = true;
        break;
      }
    }
    await Bun.sleep(1000);
  }
  if (!verified) throw new Error("Timed out verifying the installed bundled and user CLI versions");
  let port = 7700;
  const config = join(homedir(), ".orc/config.json");
  if (existsSync(config))
    port =
      (JSON.parse(readFileSync(config, "utf8")) as { api?: { port?: number } }).api?.port ?? port;
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
    signal: AbortSignal.timeout(10_000),
  });
  const health = (await response.json()) as { version?: string };
  if (!response.ok || health.version !== version)
    throw new Error(
      `Desktop installed but daemon health version is ${health.version ?? "unknown"}; expected ${version}. A separately managed daemon may need restarting.`,
    );
  console.log(`Desktop and running daemon verified at ${version}`);
}
