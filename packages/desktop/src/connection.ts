import {
  configuredApiSecret,
  loadConfig,
  type OrcConfig,
  resetConfig,
  updateGlobalConfig,
} from "@orc/core/config";
import type { Daemon } from "./daemon.js";

export function loadDesktopConfig(): OrcConfig {
  const emptySecret = process.env.ORC_API_SECRET === "";
  if (emptySecret) delete process.env.ORC_API_SECRET;
  resetConfig();
  try {
    return loadConfig();
  } finally {
    if (emptySecret) process.env.ORC_API_SECRET = "";
    resetConfig();
  }
}

export function saveDesktopConnection(config: OrcConfig, daemon: Daemon, generated?: string): void {
  const port = Number(new URL(daemon.url).port);
  const secret = daemon.owned ? configuredApiSecret(generated) : undefined;
  if (port === config.api.port && config.api.host === "127.0.0.1" && !secret) return;
  updateGlobalConfig((raw) => {
    raw.api = {
      ...(raw.api as Record<string, unknown> | undefined),
      host: "127.0.0.1",
      port,
      ...(secret ? { secret } : {}),
    };
  });
}
