import type { ChatSettings, ChatThread } from "@orc/core/chat";
import { HelpPopover } from "@/components/HelpPopover";
import { useAgentCapabilities } from "@/hooks/useAgentCapabilities";

/**
 * What Enter/Send does while a response is running. Agents without steering keep
 * queueing; the choice still applies once a steering agent is selected.
 */
export function ChatSendModeSelect({
  config,
  onChange,
  disabled = false,
  thread,
}: {
  config: ChatSettings;
  onChange: (config: ChatSettings) => void;
  disabled?: boolean;
  thread?: ChatThread | null;
}) {
  const supported = useAgentCapabilities(config.agent, thread)?.steering === true;
  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center gap-1">
        <span>While responding</span>
        <HelpPopover label="While responding" testId="chat-send-mode-help">
          Send now delivers the message into the running response so the agent sees it before its
          next step. Queue holds it until the response finishes. Attachments always queue.
          {supported
            ? ""
            : ` ${config.agent} cannot take a message mid-response, so messages wait for the next turn.`}
        </HelpPopover>
      </div>
      <select
        data-testid="chat-send-mode"
        aria-label="While responding"
        disabled={disabled}
        value={config.sendWhileRunning}
        onChange={(event) =>
          onChange({
            ...config,
            sendWhileRunning: event.target.value as ChatSettings["sendWhileRunning"],
          })
        }
        className="min-h-8 w-full rounded-md border border-control-border bg-background px-3 text-base sm:text-sm disabled:opacity-50"
      >
        <option value="steer">Send now into the response</option>
        <option value="queue">Queue for the next turn</option>
      </select>
      {!supported && (
        <p className="text-xs text-muted-foreground">
          This agent answers one message at a time, so messages queue.
        </p>
      )}
    </div>
  );
}
