import type { CreateTerminalInput, TerminalKind } from "@/api/client";

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
