import { agentLabel } from "@orc/core/coding-agents";
import { pathLabel } from "@orc/core/display-path";
import { Bot, MousePointer2, SquareTerminal } from "lucide-react";
import type { ElementType } from "react";

export function terminalKind(kind: string): { label: string; icon: ElementType } {
  if (kind === "shell") return { label: "Shell", icon: SquareTerminal };
  return { label: agentLabel(kind), icon: kind === "cursor" ? MousePointer2 : Bot };
}

export function cwdTail(cwd: string | null): string {
  return pathLabel(cwd, 2);
}
