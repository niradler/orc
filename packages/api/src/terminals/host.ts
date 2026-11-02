import { z } from "@hono/zod-openapi";
import type { OrcConfig } from "@orc/core/config";
import { ValidationError } from "@orc/core/errors";
import {
  ALIAS_PATTERN,
  type ExecHost,
  execHostFor,
  listSshConfigHosts,
  resolveExecHost,
} from "@orc/core/exec-host";

export const TerminalHostSchema = z.string().max(255).regex(ALIAS_PATTERN).nullable();
export const TerminalHostQuerySchema = z
  .union([z.literal(""), z.string().max(255).regex(ALIAS_PATTERN)])
  .optional();

export function selectedTerminalHost(
  config: OrcConfig,
  alias: string | null | undefined,
): ExecHost {
  if (alias === undefined) return resolveExecHost(config);
  const hosts = [...new Set([config.ssh.host, ...listSshConfigHosts()].filter(Boolean))];
  if (alias && !hosts.includes(alias)) {
    throw new ValidationError(
      `Unknown SSH host "${alias}". Choose one configured in ~/.ssh/config: ${hosts.join(", ") || "none"}`,
    );
  }
  return execHostFor(alias, config);
}
