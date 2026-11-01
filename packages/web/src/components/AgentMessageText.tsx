import { ORC_CONTEXT_TAG } from "@orc/core/chat-context";
import { ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { ChatUiBlock } from "@/components/chat-ui/ChatUiBlock";
import { Markdown } from "@/components/Markdown";
import { splitAgentMessage, splitUiBlocks, type UiMessagePart } from "@/lib/agent-message";

export function AgentMessageText({
  children,
  plain = false,
  revealContext = false,
}: {
  children: string;
  plain?: boolean;
  revealContext?: boolean;
}) {
  const parts = useMemo(() => {
    if (plain) return null;
    return splitAgentMessage(children).flatMap<UiMessagePart>((part) =>
      part.kind === "context"
        ? [{ kind: "text", text: part.text, offset: part.offset }]
        : splitUiBlocks(part.text).map((block) => ({
            ...block,
            offset: block.offset + part.offset,
          })),
    );
  }, [children, plain]);
  if (!parts?.some((part) => part.kind === "ui"))
    return (
      <AgentText plain={plain} revealContext={revealContext}>
        {children}
      </AgentText>
    );
  return parts.map((part) =>
    part.kind === "ui" ? (
      <ChatUiBlock key={part.offset} source={part.source} complete={part.complete} />
    ) : (
      <AgentText key={part.offset} revealContext={revealContext}>
        {part.text}
      </AgentText>
    ),
  );
}

function AgentText({
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
    // ORC's own turn context is for the agent; show it only when a search matched inside it.
    part.kind === "context" && part.tag === ORC_CONTEXT_TAG && !revealContext ? null : part.kind ===
      "context" ? (
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
          className="max-h-80 overflow-auto border-t border-outline-variant p-3 whitespace-pre-wrap wrap-break-word wrap-anywhere font-mono text-xs"
        >
          {part.text}
        </pre>
      </details>
    ) : plain ? (
      <pre key={part.offset} className="whitespace-pre-wrap wrap-break-word text-sm">
        {part.text}
      </pre>
    ) : (
      <Markdown
        key={part.offset}
        fallback={<p className="whitespace-pre-wrap wrap-break-word">{part.text}</p>}
      >
        {part.text}
      </Markdown>
    ),
  );
}
