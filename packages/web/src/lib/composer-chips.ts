import type { ChatSettings } from "@orc/core/chat";
import { type ChatAgentOptions, type ClaudeChatOptions, chatRuntime } from "@orc/core/chat-options";
import { agentForSessionBackend, codingAgent } from "@orc/core/coding-agents";
import { pathLabel } from "@orc/core/display-path";
import type { AgentCapabilities } from "@orc/core/types";

export type PermissionMode = NonNullable<ChatSettings["permissionMode"]>;
export type ComposerWorktree = {
  path: string;
  branch: string | null;
  head?: string | null;
  main?: boolean;
  detached?: boolean;
};
export type ComposerWorktreeListing = { root: string | null; worktrees: ComposerWorktree[] };

export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: "Ask in chat",
  plan: "Plan",
  acceptEdits: "Allow edits",
  auto: "Auto",
  bypassPermissions: "Full access",
};

export const PERMISSION_DESCRIPTIONS: Record<PermissionMode, string> = {
  default: "The agent's usual approvals",
  plan: "Reads and plans, never edits",
  acceptEdits: "Edits files, asks before commands",
  auto: "A classifier approves safe actions",
  bypassPermissions: "Never asks",
};

export function permissionText(
  mode: PermissionMode,
  capabilities: AgentCapabilities | undefined,
): { label: string; description: string } {
  return (
    capabilities?.permissionLabels?.[mode] ?? {
      label: PERMISSION_LABELS[mode],
      description: PERMISSION_DESCRIPTIONS[mode],
    }
  );
}

export function permissionModes(capabilities: AgentCapabilities | undefined): PermissionMode[] {
  return (
    capabilities?.permissionModes ??
    (capabilities?.livePermissions ? ["default", "acceptEdits", "bypassPermissions"] : [])
  );
}

export const PASTE_ATTACHMENT_BYTES = 16 * 1024;
export const PASTE_ATTACHMENT_LINES = 200;

function trimSeparators(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  return trimmed || path.trim().slice(0, 1);
}

function comparable(path: string): string {
  const normalized = trimSeparators(path).replace(/\\/g, "/");
  return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function pathName(path: string): string {
  return pathLabel(path.trim());
}

export function isWithin(path: string, parent: string): boolean {
  const child = comparable(path);
  const base = comparable(parent);
  if (!base) return false;
  return child === base || child.startsWith(base.endsWith("/") ? base : `${base}/`);
}

export function currentWorktree(
  listing: ComposerWorktreeListing | undefined,
  cwd: string,
): ComposerWorktree | undefined {
  if (!listing || !cwd.trim()) return undefined;
  return listing.worktrees
    .filter((worktree) => isWithin(cwd, worktree.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

export function folderChipLabel(cwd: string, listing?: ComposerWorktreeListing): string {
  if (!cwd.trim()) return "Default folder";
  const worktree = currentWorktree(listing, cwd);
  if (!worktree) return pathName(cwd);
  const main = listing?.worktrees.find((entry) => entry.main);
  const project = pathName(main?.path ?? listing?.root ?? worktree.path);
  if (comparable(cwd) === comparable(worktree.path)) return project;
  return `${project}/${pathName(cwd)}`;
}

export function branchName(worktree: ComposerWorktree | undefined): string | null {
  if (!worktree) return null;
  if (worktree.branch) return worktree.branch.replace(/^refs\/heads\//, "");
  return worktree.head ? worktree.head.slice(0, 7) : null;
}

export function branchChipLabel({
  branch,
  base,
  worktree,
}: {
  branch: string | null;
  base?: string | null;
  worktree: boolean;
}): string {
  if (worktree) return base || branch ? `New worktree from ${base || branch}` : "New worktree";
  return branch ?? "Branch";
}

export function effectivePermissionMode(config: ChatSettings): PermissionMode {
  const options = config.agentOptions[config.agent];
  const sdkMode = options?.runtime === "claude-sdk" ? options.options.permissionMode : undefined;
  return (
    sdkMode ??
    config.permissionMode ??
    (config.autoApprove
      ? ["claude", "pi"].includes(config.agent)
        ? "bypassPermissions"
        : "acceptEdits"
      : "default")
  );
}

export function withPermissionMode(config: ChatSettings, mode: PermissionMode): ChatSettings {
  const options = config.agentOptions[config.agent];
  const sdkMode = options?.runtime === "claude-sdk" ? options.options.permissionMode : undefined;
  return {
    ...config,
    permissionMode: mode,
    ...(options?.runtime === "claude-sdk" && sdkMode
      ? {
          agentOptions: {
            ...config.agentOptions,
            [config.agent]: { ...options, options: { ...options.options, permissionMode: mode } },
          },
        }
      : {}),
  };
}

const EFFORT_LABELS: Record<string, string> = {
  off: "Off",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};
/** Effort values each adapter accepts, in increasing order. */
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const PI_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
const CODEX_EFFORT_KEY = "model_reasoning_effort";

export type AgentEffortChoice = { value: string; label: string };

/** Effort choices the current adapter exposes in the composer; empty when it has none. */
export function agentEffortChoices(
  agent: string,
  modelEfforts?: readonly string[],
): AgentEffortChoice[] {
  const runtime = chatRuntime(agent);
  const known: readonly string[] =
    runtime === "claude-sdk"
      ? CLAUDE_EFFORTS
      : runtime === "pi"
        ? PI_EFFORTS
        : runtime === "codex"
          ? CODEX_EFFORTS
          : [];
  const reported =
    runtime === "codex"
      ? (modelEfforts ?? [])
      : (modelEfforts ?? []).filter((value) => known.includes(value));
  const values =
    !known.length || !modelEfforts || (modelEfforts.length && !reported.length) ? known : reported;
  return values.map((value) => ({ value, label: EFFORT_LABELS[value] ?? value }));
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^".*"$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

/** Reads a `-c key=value` pair from Codex arguments, honoring both separated and inline forms. */
function codexSetting(args: readonly string[], key: string): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const token = args[index] ?? "";
    const equals = token.indexOf("=");
    const flag = equals >= 0 ? token.slice(0, equals) : token;
    if (flag !== "-c" && flag !== "--config") continue;
    const value = equals >= 0 ? token.slice(equals + 1) : args[index + 1];
    if (value === undefined) continue;
    const split = value.indexOf("=");
    if (split > 0 && value.slice(0, split).trim() === key) return unquote(value.slice(split + 1));
    if (equals < 0) index++;
  }
  return undefined;
}

/** Returns the raw effort value selected for the current agent, or "" for the adapter default. */
export function agentEffortValue(config: ChatSettings): string {
  const options = config.agentOptions[config.agent];
  if (!options) return "";
  if (options.runtime === "claude-sdk") return options.options.effort ?? "";
  if (options.runtime === "pi") return options.options.thinkingLevel ?? "";
  if (options.runtime === "opencode") return options.options.effort ?? "";
  if (options.runtime !== "codex") return "";
  return codexSetting(options.args, CODEX_EFFORT_KEY) ?? "";
}

/** Drops every Codex `-c` entry for the key so a new effort can replace it cleanly. */
function withoutCodexSetting(args: readonly string[], key: string): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index] ?? "";
    const equals = token.indexOf("=");
    const flag = equals >= 0 ? token.slice(0, equals) : token;
    if (flag !== "-c" && flag !== "--config") {
      kept.push(token);
      continue;
    }
    const value = equals >= 0 ? token.slice(equals + 1) : args[index + 1];
    const split = value?.indexOf("=") ?? -1;
    if (value !== undefined && split > 0 && value.slice(0, split).trim() === key) {
      if (equals < 0) index++;
      continue;
    }
    kept.push(token);
    if (equals < 0 && index + 1 < args.length) kept.push(args[++index] ?? "");
  }
  return kept;
}

/** Returns a copy of the chat config with the chosen effort applied to the current agent. */
export function withAgentEffort(config: ChatSettings, value: string): ChatSettings {
  const runtime = chatRuntime(config.agent);
  const saved = config.agentOptions[config.agent];
  let options: ChatAgentOptions;
  if (runtime === "claude-sdk") {
    const next = saved?.runtime === "claude-sdk" ? { ...saved.options } : {};
    if (value) next.effort = value as NonNullable<ClaudeChatOptions["effort"]>;
    else delete next.effort;
    options = { runtime, options: next };
  } else if (runtime === "pi") {
    const next = saved?.runtime === "pi" ? { ...saved.options } : {};
    if (value) next.thinkingLevel = value as NonNullable<typeof next.thinkingLevel>;
    else delete next.thinkingLevel;
    options = { runtime, options: next };
  } else if (runtime === "codex") {
    const args = withoutCodexSetting(
      saved?.runtime === "codex" ? saved.args : [],
      CODEX_EFFORT_KEY,
    );
    if (value) args.push("-c", `${CODEX_EFFORT_KEY}="${value}"`);
    options = { runtime, args };
  } else if (runtime === "opencode") {
    const next = saved?.runtime === "opencode" ? { ...saved.options } : {};
    if (value) next.effort = value;
    else delete next.effort;
    options = { runtime, options: next };
  } else return config;
  return {
    ...config,
    agentOptions: { ...config.agentOptions, [config.agent]: options },
  };
}

export function agentEffort(config: ChatSettings): string | null {
  const value = agentEffortValue(config);
  if (!value || value === "default") return null;
  return EFFORT_LABELS[value] ?? value;
}

/** Live effort choices (OpenCode) without the adapter-default row the picker adds itself. */
export function liveEffortChoices(
  choices: readonly AgentEffortChoice[] | undefined,
): AgentEffortChoice[] {
  return (choices ?? []).filter((choice) => choice.value && choice.value !== "default");
}

export function modelDisplayName(id: string): string {
  const name = (id.split("/").pop() ?? id).replace(/\[[^\]]*\]$/, "").replace(/^claude-/, "");
  const words: string[] = [];
  for (const part of name.split("-")) {
    if (!part || /^\d{8}$/.test(part)) continue;
    const last = words[words.length - 1];
    if (last && /^\d+$/.test(part) && /\d$/.test(last)) words[words.length - 1] = `${last}.${part}`;
    else if (last === "GPT") words[words.length - 1] = `GPT-${part}`;
    else if (part.toLowerCase() === "gpt") words.push("GPT");
    else if (/^(\d|o\d)/.test(part)) words.push(part);
    else words.push(part.charAt(0).toUpperCase() + part.slice(1));
  }
  return words.join(" ") || id;
}

export function resolveAgentId(id: string | null | undefined): string | null {
  if (!id) return null;
  return codingAgent(id)?.id ?? agentForSessionBackend(id)?.id ?? null;
}

export function shouldAttachPaste(text: string): boolean {
  if (!text) return false;
  if (new TextEncoder().encode(text).length >= PASTE_ATTACHMENT_BYTES) return true;
  let lines = 1;
  for (const char of text) if (char === "\n" && ++lines >= PASTE_ATTACHMENT_LINES) return true;
  return false;
}

export function pastedTextName(existing: readonly string[]): string {
  const names = new Set(existing.map((name) => name.toLowerCase()));
  for (let index = 1; ; index++) {
    const name = `pasted-text-${index}.txt`;
    if (!names.has(name)) return name;
  }
}
