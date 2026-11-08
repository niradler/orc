import {
  agentForSessionBackend,
  CODING_AGENTS,
  type CodingAgent,
  codingAgent,
  enabledAgents,
} from "@orc/core/coding-agents";
import { ValidationError } from "@orc/core/errors";

export const LAUNCH_KINDS: readonly string[] = ["shell", ...CODING_AGENTS.map((agent) => agent.id)];

export type LaunchKind = string;

function agentFor(kind: string): CodingAgent {
  const agent = codingAgent(kind);
  if (!agent) throw new ValidationError(`Unknown terminal kind: ${kind}`);
  return agent;
}

function whichAgent(agent: CodingAgent, deps: LaunchDeps): string | null {
  for (const name of agent.binaries) {
    const resolved = deps.which(name);
    if (resolved) return resolved;
  }
  return null;
}

// Ids are uuids or similar slugs; keeping shell metacharacters out matters because a .cmd shim
// runs through cmd.exe.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface LaunchDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  which: (command: string) => string | null;
  isDirectory: (path: string) => boolean | Promise<boolean>;
  home: string;
  shell?: string | readonly string[] | undefined;
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
  host?: string | null | undefined;
  spawnArgv?: string[] | undefined;
}

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

export function defaultShell(deps: LaunchDeps): string[] | null {
  if (deps.shell) {
    if (typeof deps.shell === "string") return [deps.shell];
    if (!deps.shell.length) throw new ValidationError("A shell command needs an executable");
    return [...deps.shell];
  }
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

export function availableLaunchers(deps: LaunchDeps, enabled?: readonly string[]): LaunchKind[] {
  const agents = enabledAgents(enabled);
  return [
    ...(defaultShell(deps) ? ["shell"] : []),
    ...CODING_AGENTS.filter(
      (agent) => agents.includes(agent.id) && whichAgent(agent, deps) !== null,
    ).map((agent) => agent.id),
  ];
}

function resolveBinary(agent: CodingAgent, deps: LaunchDeps): string {
  const resolved = whichAgent(agent, deps);
  if (!resolved)
    throw new ValidationError(`${agent.binaries.join(" or ")} is not installed or not on PATH`);
  return resolved;
}

async function checkedCwd(
  cwd: string | null | undefined,
  deps: LaunchDeps,
): Promise<string | undefined> {
  if (!cwd) return undefined;
  // Native histories use extended drive paths; Windows CLI .cmd shims treat these as UNC
  // and silently fall back to C:\Windows. Preserve real UNC and non-Windows paths.
  if (deps.platform === "win32" && /^\\\\\?\\[A-Za-z]:\\/.test(cwd)) cwd = cwd.slice(4);
  if (!(await deps.isDirectory(cwd))) throw new ValidationError(`cwd is not a directory: ${cwd}`);
  return cwd;
}

export async function resumeLaunch(live: LiveSessionRef, deps: LaunchDeps): Promise<Launch> {
  const agent = agentForSessionBackend(live.agent);
  if (!agent?.resumeArgs)
    throw new ValidationError(`Resume is not supported for ${live.agent} sessions`);
  if (!live.session_id) throw new ValidationError("Session has no agent session id to resume");
  if (!isValidSessionId(live.session_id)) throw new ValidationError("Malformed session id");
  const argv = [resolveBinary(agent, deps), ...agent.resumeArgs(live.session_id)];
  return { kind: agent.id, argv, cwd: await checkedCwd(live.cwd, deps), resume: true };
}

export async function buildLaunch(req: LaunchRequest, deps: LaunchDeps): Promise<Launch> {
  if (req.live) return resumeLaunch(req.live, deps);
  const kind = req.kind ?? "shell";
  if (!LAUNCH_KINDS.includes(kind)) throw new ValidationError(`Unknown terminal kind: ${kind}`);
  const cwd = (await checkedCwd(req.cwd, deps)) ?? deps.home;
  if (kind === "shell") {
    const shell = defaultShell(deps);
    if (!shell) throw new ValidationError("No shell found on this machine");
    return { kind, argv: shell, cwd, resume: false };
  }
  return { kind, argv: [resolveBinary(agentFor(kind), deps)], cwd, resume: false };
}
