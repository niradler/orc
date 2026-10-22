import { ConflictError, OrcError } from "@orc/core/errors";
import { createLogger } from "@orc/core/logger";

const logger = createLogger("api:lifecycle");
export const instanceId = crypto.randomUUID();
let restart: (() => Promise<void>) | undefined;
let restarting = false;
const shutdownHooks: Array<() => Promise<void>> = [];

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
