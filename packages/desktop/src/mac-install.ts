import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { access, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export type MacInstall = {
  installedApp: string;
  workspace: string;
  parentPid: number;
  version: string;
  executable: string;
};

export function acknowledgeMacInstall(installedApp: string, version: string): void {
  const workspace = join(dirname(installedApp), `.${basename(installedApp)}.orc-update`);
  try {
    if (readFileSync(join(workspace, "owner"), "utf8") !== installedApp) return;
    if (readFileSync(join(workspace, "result"), "utf8").trim() !== `launching:${version}`) return;
    writeFileSync(join(workspace, "result"), `ready:${version}\n`, { mode: 0o600 });
  } catch {}
}

async function plist(bundle: string, key: string): Promise<string> {
  const { stdout } = await execute(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :${key}`, join(bundle, "Contents/Info.plist")],
    { timeout: 10_000 },
  );
  return stdout.trim();
}

async function detachMacImage(mount: string): Promise<void> {
  if ((await lstat(mount)).isSymbolicLink())
    throw new Error("Update mount cannot be a symbolic link");
  if ((await stat(mount)).dev === (await stat(dirname(mount))).dev) return;
  try {
    await execute("/usr/bin/hdiutil", ["detach", mount], { timeout: 15_000 });
  } catch {
    await execute("/usr/bin/hdiutil", ["detach", mount, "-force"], { timeout: 15_000 });
  }
}

export async function validateMacBundle(
  bundle: string,
  identity: string,
  version: string,
): Promise<void> {
  if ((await lstat(bundle)).isSymbolicLink())
    throw new Error("Update bundle cannot be a symbolic link");
  if ((await plist(bundle, "CFBundleIdentifier")) !== identity)
    throw new Error("Update bundle identity differs from this app");
  if ((await plist(bundle, "CFBundleShortVersionString")) !== version)
    throw new Error("Update bundle version differs from the release");
  const executable = await plist(bundle, "CFBundleExecutable");
  if (!/^[A-Za-z0-9._-]+$/.test(executable)) throw new Error("Invalid application executable");
  const binary = join(bundle, "Contents/MacOS", executable);
  if (!resolve(await realpath(binary)).startsWith(`${await realpath(bundle)}/`))
    throw new Error("Application executable escapes its bundle");
  await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], {
    timeout: 60_000,
  });
  const { stdout } = await execute("/usr/bin/file", ["-L", "-b", binary], { timeout: 10_000 });
  const architecture = process.arch === "x64" ? "x86_64" : process.arch;
  if (!stdout.startsWith("Mach-O") || !new RegExp(`\\b${architecture}\\b`).test(stdout))
    throw new Error("Update bundle architecture differs from this app");
}

export async function prepareMacInstall(options: {
  installedApp: string;
  image: string;
  version: string;
  sha256: string;
  cache: string;
}): Promise<MacInstall> {
  const installedApp = resolve(options.installedApp);
  if (!installedApp.endsWith(".app") || (await realpath(installedApp)) !== installedApp)
    throw new Error("Install ORC in a writable Applications folder before updating");
  await access(dirname(installedApp), constants.W_OK);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(options.image)) hash.update(chunk);
  if (hash.digest("hex") !== options.sha256)
    throw new Error("Update checksum mismatch before installation");
  const identity = await plist(installedApp, "CFBundleIdentifier");
  const workspace = join(dirname(installedApp), `.${basename(installedApp)}.orc-update`);
  try {
    await mkdir(workspace, { mode: 0o700 });
    await writeFile(join(workspace, "owner"), installedApp, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (
      (await lstat(workspace)).isSymbolicLink() ||
      (await readFile(join(workspace, "owner"), "utf8")) !== installedApp
    )
      throw new Error("Update staging ownership could not be verified");
  }
  const mount = join(options.cache, "mount");
  await mkdir(mount, { recursive: true, mode: 0o700 });
  await detachMacImage(mount);
  await rm(join(workspace, "next.app"), { recursive: true, force: true });
  try {
    await execute(
      "/usr/bin/hdiutil",
      ["attach", options.image, "-readonly", "-nobrowse", "-mountpoint", mount],
      { timeout: 60_000 },
    );
    const bundle = join(mount, "orc.app");
    await validateMacBundle(bundle, identity, options.version);
    await execute("/usr/bin/ditto", [bundle, join(workspace, "next.app")], { timeout: 120_000 });
    await validateMacBundle(join(workspace, "next.app"), identity, options.version);
  } catch (error) {
    await rm(join(workspace, "next.app"), { recursive: true, force: true });
    throw error;
  } finally {
    await detachMacImage(mount);
  }
  return {
    installedApp,
    workspace,
    parentPid: process.pid,
    version: options.version,
    executable: await plist(join(workspace, "next.app"), "CFBundleExecutable"),
  };
}

export async function launchMacInstall(install: MacInstall): Promise<void> {
  const log = openSync(join(install.workspace, "install.log"), "w", 0o600);
  try {
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        MAC_INSTALL_SCRIPT,
        "orc-update",
        String(install.parentPid),
        install.installedApp,
        install.workspace,
        install.version,
        install.executable,
      ],
      {
        detached: true,
        cwd: dirname(install.installedApp),
        stdio: ["ignore", log, log],
      },
    );
    await new Promise<void>((accept, reject) => {
      child.once("spawn", accept);
      child.once("error", reject);
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}

const MAC_INSTALL_SCRIPT = `set -eu
parent="$1"
target="$2"
workspace="$3"
version="$4"
executable="$5"
previous="$workspace/previous.app"
next="$workspace/next.app"
moved=0
launched=0
finish() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    set +e
    printf 'recovering\\n' > "$workspace/result"
    if [ "$launched" -ne 0 ]; then
      /bin/kill -TERM "$launched" 2>/dev/null || true
      attempt=0
      while /bin/kill -0 "$launched" 2>/dev/null; do
        attempt=$((attempt + 1))
        if [ "$attempt" -ge 10 ]; then /bin/kill -KILL "$launched" 2>/dev/null || true; break; fi
        /bin/sleep 1
      done
      wait "$launched" 2>/dev/null || true
    fi
    if [ "$moved" -eq 1 ]; then
      if [ -e "$target" ]; then /bin/mv "$target" "$workspace/failed.app"; fi
      /bin/mv "$previous" "$target"
    fi
    "$target/Contents/MacOS/$executable" &
    printf 'error\\n' > "$workspace/result"
  fi
  exit "$status"
}
trap finish EXIT
printf 'waiting\\n' > "$workspace/result"
attempt=0
while /bin/kill -0 "$parent" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then exit 1; fi
  /bin/sleep 1
done
if [ -L "$target" ] || [ -L "$previous" ] || [ -L "$next" ]; then exit 1; fi
/bin/rm -rf "$previous" "$workspace/failed.app"
/bin/mv "$target" "$previous"
moved=1
/bin/mv "$next" "$target"
printf 'launching:%s\\n' "$version" > "$workspace/result"
"$target/Contents/MacOS/$executable" &
launched=$!
attempt=0
while [ "$(/bin/cat "$workspace/result")" != "ready:$version" ]; do
  if ! /bin/kill -0 "$launched" 2>/dev/null; then exit 1; fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then exit 1; fi
  /bin/sleep 1
done
if ! /bin/kill -0 "$launched" 2>/dev/null; then exit 1; fi
printf 'installed\\n' > "$workspace/result"
`;
