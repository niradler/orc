import type { SessionDelivery, SessionDeliveryOutcome } from "@orc/core/session-messages";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  CornerDownRight,
} from "lucide-react";
import { type MouseEvent, memo, useId, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { deliverySessionHref } from "@/lib/session-links";
import { cn } from "@/lib/utils";

function formatDeliveryTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function outcomeDisplay(delivery: SessionDelivery): {
  label: string;
  tone: string;
  borderAccent: string;
  key: SessionDeliveryOutcome | "relay";
} {
  if (delivery.kind === "relay" || !delivery.outcome) {
    return {
      label: "Relay",
      tone: "text-on-surface-variant",
      borderAccent: "",
      key: "relay",
    };
  }
  if (delivery.outcome === "failed") {
    return {
      label: "Failed",
      tone: "text-error font-medium",
      borderAccent: "border-l-2 border-l-error",
      key: "failed",
    };
  }
  if (delivery.outcome === "waiting") {
    return {
      label:
        delivery.waiting_for === "approval"
          ? "Waiting · approval"
          : delivery.waiting_for === "question"
            ? "Waiting · question"
            : "Waiting",
      tone: "text-warning font-medium",
      borderAccent: "border-l-2 border-l-warning",
      key: "waiting",
    };
  }
  if (delivery.outcome === "interrupted") {
    return {
      label: "Interrupted",
      tone: "text-warning font-medium",
      borderAccent: "border-l-2 border-l-warning",
      key: "interrupted",
    };
  }
  if (delivery.outcome === "stopped") {
    return {
      label: "Stopped",
      tone: "text-on-surface-variant",
      borderAccent: "",
      key: "stopped",
    };
  }
  return {
    label: "Finished",
    tone: "text-on-surface-variant",
    borderAccent: "",
    key: "finished",
  };
}

function DeliveryOutcomeIcon({ outcome }: { outcome: SessionDeliveryOutcome | "relay" }) {
  if (outcome === "failed")
    return <CircleX aria-hidden="true" size={14} className="shrink-0 text-error" />;
  if (outcome === "waiting" || outcome === "interrupted")
    return <CircleAlert aria-hidden="true" size={14} className="shrink-0 text-warning" />;
  if (outcome === "finished")
    return (
      <CircleCheck aria-hidden="true" size={14} className="shrink-0 text-on-surface-variant" />
    );
  if (outcome === "stopped")
    return (
      <CircleDashed aria-hidden="true" size={14} className="shrink-0 text-on-surface-variant" />
    );
  return (
    <CornerDownRight aria-hidden="true" size={14} className="shrink-0 text-on-surface-variant" />
  );
}

export const ChatDeliveryCard = memo(function ChatDeliveryCard({
  delivery,
  fallbackTimestamp,
  fallbackBody,
  onOpenSession,
}: {
  delivery: SessionDelivery;
  fallbackTimestamp?: number;
  fallbackBody: string;
  onOpenSession?: (sessionId: string, kind: SessionDelivery["kind"]) => Promise<void> | void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const bodyId = useId();
  const display = outcomeDisplay(delivery);
  const timestamp = delivery.timestamp ?? fallbackTimestamp;
  const href = deliverySessionHref(delivery);
  const body = delivery.body?.trim() ? delivery.body : fallbackBody;

  const handleSessionClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!delivery.session_id || !onOpenSession) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
      return;
    event.preventDefault();
    setOpenError(null);
    Promise.resolve(onOpenSession(delivery.session_id, delivery.kind)).catch((cause) => {
      setOpenError(cause instanceof Error ? cause.message : "That session could not be opened.");
    });
  };

  return (
    <article
      data-testid="chat-delivery-card"
      data-kind={delivery.kind}
      data-outcome={display.key}
      data-expanded={expanded ? "true" : "false"}
      className={cn(
        "min-w-0 rounded-lg border border-outline-variant bg-surface/50 text-xs text-on-surface-variant",
        display.borderAccent,
      )}
    >
      <div className="flex min-w-0 items-center gap-1 px-1.5 py-0.5">
        <button
          type="button"
          data-testid="chat-delivery-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-focus max-sm:min-h-11 max-sm:items-start"
        >
          {expanded ? (
            <ChevronDown
              aria-hidden="true"
              size={14}
              className="shrink-0 text-outline max-sm:mt-0.5"
            />
          ) : (
            <ChevronRight
              aria-hidden="true"
              size={14}
              className="shrink-0 text-outline max-sm:mt-0.5"
            />
          )}
          <span className="shrink-0 max-sm:mt-0.5">
            <DeliveryOutcomeIcon outcome={display.key} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2">
            <span className="flex min-w-0 items-center gap-1.5 sm:shrink-0">
              <span
                data-testid="chat-delivery-title"
                title={delivery.title}
                className="min-w-0 truncate font-medium text-on-surface sm:max-w-52"
              >
                {delivery.title}
              </span>
              <span
                data-testid="chat-delivery-outcome"
                data-outcome={display.key}
                className={cn("shrink-0 whitespace-nowrap", display.tone)}
              >
                {display.label}
              </span>
            </span>
            {delivery.summary && (
              <span
                data-testid="chat-delivery-summary"
                title={delivery.summary}
                className="min-w-0 flex-1 truncate text-on-surface-variant"
              >
                {delivery.summary}
              </span>
            )}
          </span>
          {timestamp !== undefined && (
            <time
              data-testid="chat-delivery-time"
              dateTime={new Date(timestamp).toISOString()}
              title={new Date(timestamp).toLocaleString()}
              className="shrink-0 tabular-nums text-outline max-sm:mt-0.5"
            >
              {formatDeliveryTime(timestamp)}
            </time>
          )}
        </button>
        {href && (
          <a
            href={href}
            data-testid="chat-delivery-session-link"
            aria-label={`Open session ${delivery.title}`}
            onClick={handleSessionClick}
            className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-on-surface-variant hover:bg-surface hover:text-on-surface focus-visible:outline-2 focus-visible:outline-focus max-sm:min-h-11"
          >
            <span className="max-sm:sr-only">Open</span>
            <ArrowUpRight aria-hidden="true" size={13} />
          </a>
        )}
      </div>
      {openError && (
        <p role="alert" data-testid="chat-delivery-error" className="px-3 pb-2 text-xs text-error">
          {openError}
        </p>
      )}
      {expanded && (
        <div
          id={bodyId}
          data-testid="chat-delivery-body"
          className="max-h-96 overflow-y-auto border-t border-outline-variant px-3 py-2.5 text-sm text-on-surface"
        >
          <Markdown
            chat
            previewLinks
            fallback={<p className="whitespace-pre-wrap wrap-break-word">{body}</p>}
          >
            {body}
          </Markdown>
        </div>
      )}
    </article>
  );
});

export function ChatDeliveryList({
  deliveries,
  timestamp,
  rawContent,
  onOpenSession,
}: {
  deliveries: SessionDelivery[];
  timestamp?: number;
  rawContent: string;
  onOpenSession?: (sessionId: string, kind: SessionDelivery["kind"]) => Promise<void> | void;
}) {
  return (
    <div data-testid="chat-delivery-list" className="flex min-w-0 flex-col gap-1.5">
      {deliveries.map((delivery, index) => (
        <ChatDeliveryCard
          key={delivery.id ?? `${delivery.kind}-${delivery.session_id ?? index}-${index}`}
          delivery={delivery}
          fallbackTimestamp={timestamp}
          fallbackBody={rawContent}
          onOpenSession={onOpenSession}
        />
      ))}
    </div>
  );
}
