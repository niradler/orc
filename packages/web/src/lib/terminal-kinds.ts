import { agentLabel } from "@orc/core/coding-agents";
import { Bot, MousePointer2, SquareTerminal } from "lucide-react";
import type { ElementType } from "react";

export function terminalKind(kind: string): { label: string; icon: ElementType } {
  if (kind === "shell") return { label: "Shell", icon: SquareTerminal };
  return { label: agentLabel(kind), icon: kind === "cursor" ? MousePointer2 : Bot };
}

export function cwdTail(cwd: string | null): string {
  if (!cwd) return "";
  const segments = cwd.split(/[\\/]+/).filter(Boolean);
  return segments.slice(-2).join("/") || cwd;
}
