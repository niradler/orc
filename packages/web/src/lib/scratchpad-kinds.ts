import type { ScratchpadKind } from "@orc/core/scratchpad";
import { Code2, FileText, type LucideIcon, Shapes } from "lucide-react";

export const KIND_META: Record<ScratchpadKind, { label: string; icon: LucideIcon; hint: string }> =
  {
    doc: { label: "Doc", icon: FileText, hint: "Markdown with mermaid diagrams" },
    diagram: { label: "Diagram", icon: Shapes, hint: "Excalidraw canvas" },
    html: { label: "HTML", icon: Code2, hint: "A page shown in a sandboxed frame" },
  };
