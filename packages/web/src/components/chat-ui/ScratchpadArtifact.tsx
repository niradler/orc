import type { Scratchpad } from "@orc/core/scratchpad";
import { lazy, Suspense } from "react";
import { Markdown } from "@/components/Markdown";
import { withOrcKit } from "@/lib/orc-kit";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { isolatedHtml } from "./sandboxed-html";

const DiagramPreview = lazy(() => import("./ScratchpadDiagramPreview"));

export function ScratchpadArtifact({
  pad,
  expanded,
  fullscreen = false,
}: {
  pad: Scratchpad;
  expanded: boolean;
  fullscreen?: boolean;
}) {
  const { theme } = useTheme();
  if (pad.kind === "html") {
    return (
      <iframe
        data-testid="chat-ui-scratchpad-html"
        title={`${pad.title} preview`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={isolatedHtml(withOrcKit(pad.content, theme))}
        className={cn(
          "w-full border border-outline-variant bg-white",
          fullscreen ? "h-full min-h-0" : expanded ? "h-[70vh] min-h-80" : "h-72",
        )}
      />
    );
  }
  if (pad.kind === "diagram") {
    return (
      <Suspense fallback={<p role="status">Loading diagram…</p>}>
        <DiagramPreview
          key={pad.content}
          content={pad.content}
          title={pad.title}
          expanded={expanded}
          fullscreen={fullscreen}
        />
      </Suspense>
    );
  }
  if (fullscreen && pad.kind !== "doc")
    return (
      <div className="min-h-0 flex-1 overflow-auto">
        <Markdown readable>{pad.content}</Markdown>
      </div>
    );
  if (expanded) return <Markdown readable>{pad.content}</Markdown>;
  return <p className="line-clamp-4 whitespace-pre-wrap break-words text-xs">{pad.content}</p>;
}
