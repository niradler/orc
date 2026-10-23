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
  if (alias && alias !== config.ssh.host && !listSshConfigHosts().includes(alias)) {
    throw new ValidationError("Choose an SSH host configured in ~/.ssh/config");
  }
  return execHostFor(alias, config);
}
