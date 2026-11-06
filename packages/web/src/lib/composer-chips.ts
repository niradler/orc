import type { ChatSettings } from "@orc/core/chat";
import { agentForSessionBackend, codingAgent } from "@orc/core/coding-agents";

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
  acceptEdits: "Allow edits",
  bypassPermissions: "Full access",
};

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
  const trimmed = trimSeparators(path);
  const name = trimmed.split(/[\\/]/).pop() ?? "";
  return name || trimmed;
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
  worktree,
}: {
  branch: string | null;
  worktree: boolean;
}): string {
  if (worktree) return branch ? `New worktree from ${branch}` : "New worktree";
  return branch ?? "Branch";
}

export function effectivePermissionMode(config: ChatSettings): PermissionMode {
  const options = config.agentOptions[config.agent];
  const sdkMode = options?.runtime === "claude-sdk" ? options.options.permissionMode : undefined;
  return (
    sdkMode ??
    config.permissionMode ??
    (config.autoApprove
      ? config.agent === "claude"
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
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function agentEffort(config: ChatSettings): string | null {
  const options = config.agentOptions[config.agent];
  if (!options) return null;
  if (options.runtime === "claude-sdk")
    return options.options.effort ? EFFORT_LABELS[options.options.effort] : null;
  if (options.runtime !== "codex") return null;
  for (const arg of options.args) {
    const match = /^model_reasoning_effort\s*=\s*"?([a-z]+)"?$/i.exec(arg.trim());
    if (match?.[1]) return EFFORT_LABELS[match[1].toLowerCase()] ?? match[1];
  }
  return null;
}

export function agentModelLabel(model: string, effort: string | null): string {
  return effort ? `${model} · ${effort}` : model;
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
