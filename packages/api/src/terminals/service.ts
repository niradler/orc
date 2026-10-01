import { statSync } from "node:fs";
import { homedir } from "node:os";
import { loadConfig, type OrcConfig } from "@orc/core/config";
import { ForbiddenError } from "@orc/core/errors";
import type { LaunchDeps } from "./launch.js";
import { TerminalManager } from "./manager.js";
import { spawnPty } from "./spawn.js";

export interface Availability {
  ready: boolean;
  reason: string | null;
}

let manager: TerminalManager | null = null;

export function terminalsAvailability(config: OrcConfig): Availability {
  if (!config.terminals.enabled) {
    return {
      ready: false,
      reason: "Terminals are disabled. Set terminals.enabled in config or ORC_TERMINALS_ENABLED=1.",
    };
  }
  if (!config.api.secret) {
    return {
      ready: false,
      reason:
        "Terminals start processes on this machine and need an API secret. Set api.secret in config or ORC_API_SECRET.",
    };
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
    which: (command) => Bun.which(command),
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
