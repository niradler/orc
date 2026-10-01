import { ValidationError } from "@orc/core/errors";

export const LAUNCH_KINDS = ["shell", "claude", "codex", "cursor"] as const;

export type LaunchKind = (typeof LAUNCH_KINDS)[number];

const AGENT_BINARY: Record<Exclude<LaunchKind, "shell">, string> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor-agent",
};

const SESSION_ID_PATTERN = /^[A-Za-z0-9][!-~]{0,255}$/;

export interface LaunchDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  which: (command: string) => string | null;
  isDirectory: (path: string) => boolean;
  home: string;
  shell?: string | undefined;
}

export interface LiveSessionRef {
  agent: string;
  session_id: string | null;
  cwd: string | null;
}

export interface LaunchRequest {
  kind?: LaunchKind | undefined;
  cwd?: string | null | undefined;
  live?: LiveSessionRef;
}

export interface Launch {
  kind: LaunchKind;
  argv: string[];
  cwd: string | undefined;
  resume: boolean;
}

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

export function defaultShell(deps: LaunchDeps): string[] | null {
  if (deps.shell) return [deps.shell];
  if (deps.platform === "win32") {
    const pwsh = deps.which("pwsh");
    if (pwsh) return [pwsh, "-NoLogo"];
    const powershell = deps.which("powershell");
    if (powershell) return [powershell, "-NoLogo"];
    return deps.env.COMSPEC ? [deps.env.COMSPEC] : null;
  }
  if (deps.platform === "darwin") return [deps.env.SHELL || "/bin/zsh", "-l"];
  return [deps.env.SHELL || "/bin/bash"];
}

export function availableLaunchers(deps: LaunchDeps): LaunchKind[] {
  return LAUNCH_KINDS.filter((kind) => {
    if (kind === "shell") return defaultShell(deps) !== null;
    return deps.which(AGENT_BINARY[kind]) !== null;
  });
}

function resolveBinary(kind: Exclude<LaunchKind, "shell">, deps: LaunchDeps): string {
  const resolved = deps.which(AGENT_BINARY[kind]);
  if (!resolved) throw new ValidationError(`${AGENT_BINARY[kind]} is not installed or not on PATH`);
  return resolved;
}

function checkedCwd(cwd: string | null | undefined, deps: LaunchDeps): string | undefined {
  if (!cwd) return undefined;
  if (!deps.isDirectory(cwd)) throw new ValidationError(`cwd is not a directory: ${cwd}`);
  return cwd;
}

export function resumeLaunch(live: LiveSessionRef, deps: LaunchDeps): Launch {
  if (live.agent !== "claude" && live.agent !== "codex") {
    throw new ValidationError(`Resume is not supported for ${live.agent} sessions`);
  }
  if (!live.session_id) throw new ValidationError("Session has no agent session id to resume");
  if (!isValidSessionId(live.session_id)) throw new ValidationError("Malformed session id");
  const binary = resolveBinary(live.agent, deps);
  const argv =
    live.agent === "claude"
      ? [binary, "--resume", live.session_id]
      : [binary, "resume", live.session_id];
  return { kind: live.agent, argv, cwd: checkedCwd(live.cwd, deps), resume: true };
}

export function buildLaunch(req: LaunchRequest, deps: LaunchDeps): Launch {
  if (req.live) return resumeLaunch(req.live, deps);
  const kind = req.kind ?? "shell";
  if (!LAUNCH_KINDS.includes(kind)) throw new ValidationError(`Unknown terminal kind: ${kind}`);
  const cwd = checkedCwd(req.cwd, deps) ?? deps.home;
  if (kind === "shell") {
    const shell = defaultShell(deps);
    if (!shell) throw new ValidationError("No shell found on this machine");
    return { kind, argv: shell, cwd, resume: false };
  }
  return { kind, argv: [resolveBinary(kind, deps)], cwd, resume: false };
}
