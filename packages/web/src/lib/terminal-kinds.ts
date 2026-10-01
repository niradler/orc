import { Bot, MousePointer2, SquareTerminal } from "lucide-react";
import type { ElementType } from "react";
import type { TerminalKind } from "@/api/client";

export const TERMINAL_KINDS: Record<TerminalKind, { label: string; icon: ElementType }> = {
  shell: { label: "Shell", icon: SquareTerminal },
  claude: { label: "Claude", icon: Bot },
  codex: { label: "Codex", icon: Bot },
  cursor: { label: "Cursor", icon: MousePointer2 },
};

export function cwdTail(cwd: string | null): string {
  if (!cwd) return "";
  const segments = cwd.split(/[\\/]+/).filter(Boolean);
  return segments.slice(-2).join("/") || cwd;
}
