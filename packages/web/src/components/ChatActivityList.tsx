import { type ChatActivity, ChatActivitySchema } from "@orc/core/chat";
import { ChevronRight } from "lucide-react";
import { groupChatActivity } from "@/lib/chat-activity";

function ActivityItem({ item }: { item: ChatActivity }) {
  return item.type === "status" ? (
    <p className="py-1 wrap-break-word">{item.text}</p>
  ) : (
    <details
      data-testid={item.type === "thinking" ? "chat-thinking" : "chat-tool"}
      className="group/item rounded-md border border-outline-variant"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 hover:bg-surface">
        <ChevronRight aria-hidden="true" size={14} className="shrink-0 group-open/item:rotate-90" />
        <span className="min-w-0 flex-1 truncate">
          {item.type === "thinking" ? "Thinking" : item.name}
        </span>
        {item.type === "tool" && (
          <span className={item.isError ? "text-error" : ""}>
            {item.result === undefined ? "Started" : item.isError ? "Failed" : "Completed"}
          </span>
        )}
      </summary>
      <div className="max-h-72 overflow-auto border-t border-outline-variant px-3 py-2 whitespace-pre-wrap wrap-break-word wrap-anywhere">
        {item.type === "thinking" ? (
          item.text
        ) : (
          <>
            <p className="mb-1 font-medium">Input</p>
            <pre className="whitespace-pre-wrap wrap-break-word font-mono">
              {item.input || "No arguments"}
            </pre>
            {item.result !== undefined && (
              <>
                <p className="mt-3 mb-1 font-medium">Result</p>
                <pre className="whitespace-pre-wrap wrap-break-word font-mono">
                  {item.result || "Completed without output"}
                </pre>
              </>
            )}
          </>
        )}
      </div>
    </details>
  );
}

export function ChatActivityList({ value }: { value: unknown }) {
  if (!Array.isArray(value)) return null;
  const items = value.flatMap((item) => {
    const parsed = ChatActivitySchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
  if (!items.length) return null;
  return (
    <div data-testid="chat-activity" className="mb-3 space-y-1 text-xs text-on-surface-variant">
      {groupChatActivity(items).map((item) =>
        item.type === "tools" ? (
          <details
            key={item.id}
            data-testid="chat-tool-group"
            className="group/tools rounded-md border border-outline-variant"
          >
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 hover:bg-surface">
              <ChevronRight
                aria-hidden="true"
                size={14}
                className="shrink-0 group-open/tools:rotate-90"
              />
              <span className="min-w-0 flex-1">{item.items.length} tool calls</span>
              {item.items.some((tool) => tool.isError) && (
                <span className="text-error">
                  {item.items.filter((tool) => tool.isError).length} failed
                </span>
              )}
              {item.items.some((tool) => tool.result === undefined) && <span>Running</span>}
            </summary>
            <div className="space-y-1 border-t border-outline-variant p-2">
              {item.items.map((tool) => (
                <ActivityItem key={tool.id} item={tool} />
              ))}
            </div>
          </details>
        ) : (
          <ActivityItem key={item.id} item={item} />
        ),
      )}
    </div>
  );
}
