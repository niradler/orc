import type { ComposerProfile } from "@orc/core/chat";
import { TERMINAL_LAUNCH_SUPPORT, type TerminalLaunchOptions } from "@orc/core/chat-options";
import type { CreateTerminalInput, TerminalKind } from "@/api/client";
import type { PermissionMode } from "@/lib/composer-chips";

export const CWD_KEY = "orc_terminal_cwd";
export const WORKTREE_KEY = "orc_terminal_worktree";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export interface LaunchPrefs {
  cwd: string;
  worktree: boolean;
}

export function readLaunchPrefs(storage: Storage | undefined): LaunchPrefs {
  try {
    return {
      cwd: storage?.getItem(CWD_KEY) ?? "",
      worktree: storage?.getItem(WORKTREE_KEY) === "1",
    };
  } catch {
    return { cwd: "", worktree: false };
  }
}

export function saveLaunchPref(
  storage: Storage | undefined,
  key: typeof CWD_KEY | typeof WORKTREE_KEY,
  value: string,
): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Private windows and blocked storage just don't remember.
  }
}

// Agents are pointed at a project, so an empty folder means "ask" rather than "home".
export function needsFolderPick(kind: TerminalKind, cwd: string): boolean {
  return kind !== "shell" && cwd.trim() === "";
}

export function launchRequest(
  kind: TerminalKind,
  cwd: string,
  worktree: boolean,
): CreateTerminalInput {
  const folder = cwd.trim();
  return {
    kind,
    ...(folder ? { cwd: folder } : {}),
    ...(worktree && kind !== "shell" && folder ? { worktree: true } : {}),
  };
}

export function terminalModes(agent: string): PermissionMode[] {
  return (TERMINAL_LAUNCH_SUPPORT[agent]?.modes ?? []).filter(
    (mode) => mode !== "default" || agent === "codex",
  );
}

export function terminalProfileOptions(profile: ComposerProfile): TerminalLaunchOptions {
  const support = TERMINAL_LAUNCH_SUPPORT[profile.agent];
  if (!support) return {};
  const mode = profile.permissionMode;
  return {
    ...(profile.model ? { model: profile.model } : {}),
    ...(support.effort && profile.effort ? { effort: profile.effort } : {}),
    ...(mode && terminalModes(profile.agent).includes(mode) ? { permissionMode: mode } : {}),
  };
}
