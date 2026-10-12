import { statSync } from "node:fs";
import { homedir } from "node:os";
import { configuredApiSecret, loadConfig, type OrcConfig } from "@orc/core/config";
import { ConflictError, ForbiddenError, ValidationError } from "@orc/core/errors";
import {
  type ExecHost,
  ensureSshMaster,
  envScript,
  execHostFor,
  forwardedEnv,
  hostIsDirectory,
  hostMakeDirectory,
  LOCAL_HOST,
  probeHost,
  remoteCommand,
  remoteTempPath,
  resolveExecHost,
  sshArgv,
  writeHostFile,
} from "@orc/core/exec-host";
import { ulid } from "@orc/core/ids";
import { resolvePackageAgentBinary } from "@orc/core/package-launch";
import type { Launch, LaunchDeps } from "./launch.js";
import { TerminalManager } from "./manager.js";
import { folderPickerLaunch, pickFolder } from "./pick-folder.js";
import { buildPtyEnv } from "./pty-env.js";
import { gitRunner, type SessionDirDeps } from "./session-dir.js";
import { MIN_BUN_VERSION, spawnPty } from "./spawn.js";

export interface Availability {
  ready: boolean;
  reason: string | null;
}

let manager: TerminalManager | null = null;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function terminalsAvailability(
  config: OrcConfig,
  bunVersion: string = Bun.version,
): Availability {
  if (!config.terminals.enabled) {
    return {
      ready: false,
      reason:
        "Terminals are disabled. Set terminals.enabled to true in config, or ORC_TERMINALS_ENABLED=1.",
    };
  }
  if (!Bun.semver.satisfies(bunVersion, `>=${MIN_BUN_VERSION}`)) {
    return {
      ready: false,
      reason: `Terminals need Bun ${MIN_BUN_VERSION} or newer (running ${bunVersion}).`,
    };
  }
  if (!configuredApiSecret(config.api.secret)) {
    if (!config.terminals.allow_without_secret) {
      return {
        ready: false,
        reason:
          "Terminals start processes on this machine and need an API secret. Set api.secret in config or ORC_API_SECRET, or opt in to secretless local use with terminals.allow_without_secret.",
      };
    }
    if (!LOOPBACK_HOSTS.has(config.api.host)) {
      return {
        ready: false,
        reason: `terminals.allow_without_secret only works when the API is bound to loopback (api.host is ${config.api.host}). Set api.secret.`,
      };
    }
  }
  return { ready: true, reason: null };
}

export function requireTerminals(config: OrcConfig): void {
  const { ready, reason } = terminalsAvailability(config);
  if (!ready) throw new ForbiddenError(reason ?? "Terminals unavailable", "TERMINALS_UNAVAILABLE");
}

export async function launchDeps(
  config: OrcConfig,
  host: ExecHost = resolveExecHost(config),
): Promise<LaunchDeps> {
  if (host.kind === "ssh") {
    const probe = await probeHost(host);
    return {
      platform: "linux",
      env: { SHELL: probe.shell },
      which: (command) => probe.binaries[command] ?? null,
      isDirectory: (path) => hostIsDirectory(host, path),
      home: probe.home,
    };
  }
  return {
    platform: process.platform,
    env: process.env,
    // Pass PATH explicitly: on Linux Bun.which can use the PATH from process start, ignoring
    // later changes to process.env.PATH.
    which: (command) => resolvePackageAgentBinary(command),
    isDirectory: (path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    home: homedir(),
    shell: config.terminals.shell,
  };
}

export function sessionDirDeps(deps: LaunchDeps, host: ExecHost = LOCAL_HOST): SessionDirDeps {
  return {
    isDirectory: deps.isDirectory,
    home: deps.home,
    runGit: gitRunner(host),
    makeDirectory: (path) => hostMakeDirectory(host, path),
    newId: ulid,
  };
}

export async function launchOnHost(host: ExecHost, launch: Launch): Promise<Launch> {
  if (host.kind === "local") return { ...launch, host: null };
  await ensureSshMaster(host);
  const envFile = remoteTempPath(".env");
  await writeHostFile(host, envFile, envScript(forwardedEnv(host, buildPtyEnv(process.env))));
  return {
    ...launch,
    host: host.alias,
    spawnArgv: sshArgv(host, remoteCommand(launch.argv, { cwd: launch.cwd, envFile }), {
      tty: true,
    }),
  };
}

export function terminalHost(id: string): {
  host: ExecHost;
  cwd: string | null;
} {
  const info = getTerminalManager().get(id);
  return { host: execHostFor(info.host), cwd: info.cwd };
}

let picking = false;

// One native dialog at a time: a second click while one is open would stack hidden dialogs.
export async function pickFolderOnce(initial: string | undefined): Promise<string | null> {
  if (resolveExecHost().kind === "ssh")
    throw new ValidationError(
      "An SSH host is selected, so folders live on that host. Browse its folders instead of the native dialog.",
    );
  if (picking) throw new ConflictError("A folder dialog is already open");
  picking = true;
  try {
    return await pickFolder(
      folderPickerLaunch({
        platform: process.platform,
        which: (command) => Bun.which(command, { PATH: process.env.PATH ?? "" }),
        initial,
      }),
    );
  } finally {
    picking = false;
  }
}

export function getTerminalManager(): TerminalManager {
  if (!manager) {
    const { terminals } = loadConfig();
    manager = new TerminalManager({
      spawn: spawnPty,
      env: process.env,
      max: terminals.max,
      scrollbackBytes: terminals.scrollback_bytes,
      answerDeviceAttributes: process.platform !== "win32",
    });
  }
  return manager;
}

export function setTerminalManager(next: TerminalManager | null): void {
  manager = next;
}

export function shutdownTerminals(): void {
  manager?.shutdown();
  manager = null;
}
