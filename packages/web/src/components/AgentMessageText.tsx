import { ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { Markdown } from "@/components/Markdown";
import { splitAgentMessage } from "@/lib/agent-message";

export function AgentMessageText({
  children,
  plain = false,
  revealContext = false,
}: {
  children: string;
  plain?: boolean;
  revealContext?: boolean;
}) {
  const parts = useMemo(() => splitAgentMessage(children), [children]);
  return parts.map((part) =>
    part.kind === "context" ? (
      <details
        key={part.offset}
        open={revealContext || undefined}
        data-testid="agent-context"
        data-tag={part.tag}
        className="group my-2 min-w-0 rounded-md border border-outline-variant text-on-surface-variant"
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-xs hover:bg-surface">
          <ChevronRight size={14} aria-hidden="true" className="shrink-0 group-open:rotate-90" />
          <span className="min-w-0 break-all font-mono">{`<${part.tag}>`}</span>
        </summary>
        <pre
          data-testid="agent-context-content"
          className="max-h-80 overflow-auto border-t border-outline-variant p-3 whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-mono text-xs"
        >
          {part.text}
        </pre>
      </details>
    ) : plain ? (
      <pre key={part.offset} className="whitespace-pre-wrap break-words text-sm">
        {part.text}
      </pre>
    ) : (
      <Markdown
        key={part.offset}
        fallback={<p className="whitespace-pre-wrap break-words">{part.text}</p>}
      >
        {part.text}
      </Markdown>
    ),
  );
}
