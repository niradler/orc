import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export const TARGETS = [
  { id: "windows-x64", os: "win", arch: "x64", runner: "windows-latest", extension: "exe" },
  { id: "mac-arm64", os: "mac", arch: "arm64", runner: "macos-latest", extension: "dmg" },
  { id: "linux-x64", os: "linux", arch: "x64", runner: "ubuntu-latest", extension: "AppImage" },
  {
    id: "linux-arm64",
    os: "linux",
    arch: "arm64",
    runner: "ubuntu-24.04-arm",
    extension: "AppImage",
  },
] as const;

export const BINARIES = [
  "orc-linux-x64",
  "orc-linux-arm64",
  "orc-mac-arm64",
  "orc-mac-x64",
  "orc-windows-x64.exe",
];

export function bumpPatch(version: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Expected stable semver: ${version}`);
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${(patch ?? 0) + 1}`;
}

export function hostTarget(): string {
  const platform =
    process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux";
  return `${platform}-${process.arch}`;
}

export function installerName(version: string, target: string): string {
  const entry = TARGETS.find((item) => item.id === target);
  if (!entry) throw new Error(`Unsupported desktop target: ${target}`);
  bumpPatch(version);
  const artifactArch = entry.id === "linux-x64" ? "x86_64" : entry.arch;
  return `orc-${version}-${entry.os}-${artifactArch}.${entry.extension}`;
}

export function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function desktopMatrix(
  version: string,
  target: string,
  expectedVersion: string,
): { include: (typeof TARGETS)[number][] } {
  bumpPatch(version);
  if (version !== expectedVersion || !TARGETS.some((entry) => entry.id === target))
    throw new Error("Invalid release build plan");
  return { include: TARGETS.filter((entry) => entry.id !== target) };
}

export async function completeStep(
  completed: string[],
  name: string,
  action: () => void | Promise<void>,
  save: () => void,
): Promise<void> {
  if (completed.includes(name)) return;
  await action();
  completed.push(name);
  save();
}

export function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    capture?: boolean;
    timeout?: number;
    quiet?: boolean;
    env?: Record<string, string>;
  } = {},
): string {
  let executable = command;
  let parameters = args;
  if (command === "npm" && process.platform === "win32") {
    const npm = Bun.which("npm");
    if (!npm) throw new Error("npm is missing from PATH");
    const directory = dirname(realpathSync(npm));
    const cli = [
      join(directory, "node_modules/npm/bin/npm-cli.js"),
      join(directory, "../node_modules/npm/bin/npm-cli.js"),
      join(directory, "npm-cli.js"),
    ].find(existsSync);
    if (!cli)
      throw new Error(
        "Cannot locate npm-cli.js beside npm; install a standard Node/npm distribution",
      );
    executable = "node";
    parameters = [cli, ...args];
  }
  if (!options.quiet) console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(executable, parameters, {
    cwd: options.cwd,
    timeout: options.timeout ?? 30 * 60_000,
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...options.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args[0] ?? ""} failed (${result.status}): ${options.capture ? result.stderr.trim() : "see output above"}`,
    );
  }
  return options.capture ? result.stdout.trim() : "";
}
