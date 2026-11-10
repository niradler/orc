import type { Scratchpad } from "@orc/core/scratchpad";
import { lazy, Suspense } from "react";
import { Markdown } from "@/components/Markdown";
import { withOrcKit } from "@/lib/orc-kit";
import { useTheme } from "@/lib/theme";

const DiagramPreview = lazy(() => import("./ScratchpadDiagramPreview"));

// An opaque origin plus CSP keeps generated scripts away from ORC storage, API
// credentials. CSP blocks connections/external resources; embed data and chart code.
const HTML_POLICY = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'`;

function isolatedHtml(content: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${HTML_POLICY}">`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(content);
  return doctype
    ? `${doctype[0]}${policy}${content.slice(doctype[0].length)}`
    : `${policy}${content}`;
}

export function ScratchpadArtifact({ pad, expanded }: { pad: Scratchpad; expanded: boolean }) {
  const { theme } = useTheme();
  if (pad.kind === "html") {
    return (
      <iframe
        data-testid="chat-ui-scratchpad-html"
        title={`${pad.title} preview`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={isolatedHtml(withOrcKit(pad.content, theme))}
        className={`w-full border border-outline-variant bg-white ${expanded ? "h-[70vh] min-h-80" : "h-72"}`}
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
        />
      </Suspense>
    );
  }
  if (expanded) return <Markdown readable>{pad.content}</Markdown>;
  return <p className="line-clamp-4 whitespace-pre-wrap break-words text-xs">{pad.content}</p>;
}
