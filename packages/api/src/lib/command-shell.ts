import { ValidationError } from "@orc/core/errors";
import { defaultShell, type LaunchDeps } from "../terminals/launch.js";

export function commandShell(deps: LaunchDeps): string[] {
  const shell = defaultShell(deps);
  if (!shell) throw new ValidationError("No shell found on the execution host");
  const name = shell[0]
    ?.split(/[\\/]/)
    .pop()
    ?.replace(/\.exe$/i, "")
    .toLowerCase();
  if (name === "pwsh" || name === "powershell")
    return [...shell, "-NoProfile", "-NonInteractive", "-Command"];
  if (name === "cmd") return [...shell, "/d", "/s", "/c"];
  return [...shell, "-c"];
}
