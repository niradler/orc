import { ORC_CONTEXT_TAG } from "@orc/core/chat-context";
import { ChevronRight } from "lucide-react";
import { createContext, memo, type ReactNode, useContext, useMemo } from "react";
import { ChatUiBlock } from "@/components/chat-ui/ChatUiBlock";
import { Markdown } from "@/components/Markdown";
import { splitAgentMessage, splitUiBlocks, type UiMessagePart } from "@/lib/agent-message";
import { splitStreamingMarkdown } from "@/lib/streaming-markdown";

/**
 * A live message re-renders on every token. The provider tells the text parts
 * below `MessagePrimitive.Parts` that the answer is still running, so they can
 * split it into stable markdown blocks instead of re-parsing the whole answer.
 */
const AgentTextStreaming = createContext(false);

export function AgentTextStreamProvider({
  streaming,
  children,
}: {
  streaming: boolean;
  children: ReactNode;
}) {
  return <AgentTextStreaming.Provider value={streaming}>{children}</AgentTextStreaming.Provider>;
}

/** A settled block only re-renders when its own text changes; the growing tail
 *  is the single block whose string differs between tokens. */
const StreamingBlock = memo(function StreamingBlock({ text }: { text: string }) {
  return (
    <Markdown previewLinks fallback={<p className="whitespace-pre-wrap wrap-break-word">{text}</p>}>
      {text}
    </Markdown>
  );
});

export function AgentMessageText({
  children,
  plain = false,
  revealContext = false,
  streaming,
}: {
  children: string;
  plain?: boolean;
  revealContext?: boolean;
  /** Overrides the provider; a finished message renders one document as before. */
  streaming?: boolean;
}) {
  const fromProvider = useContext(AgentTextStreaming);
  const live = streaming ?? fromProvider;
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
      <AgentText plain={plain} revealContext={revealContext} streaming={live}>
        {children}
      </AgentText>
    );
  return parts.map((part) =>
    part.kind === "ui" ? (
      // A live orc-ui fence stays on the completeness path in ChatUiBlock.
      <ChatUiBlock key={part.offset} source={part.source} complete={part.complete} />
    ) : (
      <AgentText key={part.offset} revealContext={revealContext} streaming={live}>
        {part.text}
      </AgentText>
    ),
  );
}

function AgentText({
  children,
  plain = false,
  revealContext = false,
  streaming = false,
}: {
  children: string;
  plain?: boolean;
  revealContext?: boolean;
  streaming?: boolean;
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
    ) : streaming ? (
      // Same spacing as one Streamdown document: blocks are its top-level children.
      <div key={part.offset} className="space-y-4">
        {splitStreamingMarkdown(part.text).map((block, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional and the settled prefix keeps its index
          <StreamingBlock key={index} text={block} />
        ))}
      </div>
    ) : (
      <Markdown
        key={part.offset}
        previewLinks
        fallback={<p className="whitespace-pre-wrap wrap-break-word">{part.text}</p>}
      >
        {part.text}
      </Markdown>
    ),
  );
}
