import { statSync } from "node:fs";
import { homedir } from "node:os";
import { loadConfig, type OrcConfig } from "@orc/core/config";
import { ForbiddenError } from "@orc/core/errors";
import type { LaunchDeps } from "./launch.js";
import { TerminalManager } from "./manager.js";
import { MIN_BUN_VERSION, spawnPty } from "./spawn.js";

export interface Availability {
  ready: boolean;
  reason: string | null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

let manager: TerminalManager | null = null;

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
  if (!config.api.secret) {
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

export function launchDeps(config: OrcConfig): LaunchDeps {
  return {
    platform: process.platform,
    env: process.env,
    // Pass PATH explicitly: on Linux Bun.which can use the PATH from process start, ignoring
    // later changes to process.env.PATH.
    which: (command) => Bun.which(command, { PATH: process.env.PATH ?? "" }),
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
