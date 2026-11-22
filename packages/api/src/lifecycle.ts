import { ConflictError, OrcError } from "@orc/core/errors";
import { createLogger } from "@orc/core/logger";

const logger = createLogger("api:lifecycle");
export const instanceId = crypto.randomUUID();
let restart: (() => Promise<void>) | undefined;
let restarting = false;
let draining = false;
const shutdownHooks: Array<() => Promise<void>> = [];

/**
 * Shutdown marks the daemon draining before anything tears down: new chat turns
 * are refused while active ones finish and persist their resumable identity.
 */
export function beginDrain(): void {
  draining = true;
}

export function isDraining(): boolean {
  return draining;
}

export function registerRestartHandler(handler: (() => Promise<void>) | undefined): void {
  restart = handler;
  restarting = false;
}

export function canRestart(): boolean {
  return restart !== undefined;
}

export function requestRestart(): void {
  if (!restart)
    throw new OrcError("Server restart is unavailable in this runtime", "RESTART_UNAVAILABLE", 503);
  if (restarting) throw new ConflictError("Server restart is already in progress");
  restarting = true;
  const handler = restart;
  setTimeout(() => {
    void handler().catch((error) => {
      restarting = false;
      logger.error("Server restart failed", error);
    });
  }, 250);
}

let stop: (() => Promise<void>) | undefined;
let stopping = false;

export function registerShutdownHandler(handler: (() => Promise<void>) | undefined): void {
  stop = handler;
  stopping = false;
}

export function canShutdown(): boolean {
  return stop !== undefined;
}

/** Graceful stop for callers that cannot deliver a POSIX signal (Windows, where
 *  signaling another process is a hard kill): drain, persist, then exit. */
export function requestShutdown(): void {
  if (!stop)
    throw new OrcError(
      "Server shutdown is unavailable in this runtime",
      "SHUTDOWN_UNAVAILABLE",
      503,
    );
  if (stopping) throw new ConflictError("Server shutdown is already in progress");
  stopping = true;
  const handler = stop;
  setTimeout(() => {
    void handler().catch((error) => {
      stopping = false;
      logger.error("Server shutdown failed", error);
    });
  }, 250);
}

export function registerShutdownHook(hook: () => Promise<void>): void {
  shutdownHooks.push(hook);
}

export async function runShutdownHooks(): Promise<void> {
  for (const hook of shutdownHooks) {
    try {
      await hook();
    } catch (error) {
      logger.error("Shutdown hook failed", error);
    }
  }
}
