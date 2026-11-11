import { homedir } from "node:os";
import { join } from "node:path";

export function userHome(): string {
  return (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) || homedir();
}

/** Root of ORC's persistent state (config, database, secret key, logs); ORC_HOME overrides ~/.orc. */
export function orcHome(): string {
  const configured = process.env.ORC_HOME?.trim();
  return configured ? configured : join(userHome(), ".orc");
}
