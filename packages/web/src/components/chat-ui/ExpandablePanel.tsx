import { Maximize2 } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ChatUiActionFeedback } from "./actions";
import { Panel } from "./primitives";

export function ExpandablePanel({
  title,
  heading,
  testId,
  canExpand,
  children,
}: {
  title: string;
  heading?: ReactNode;
  testId: string;
  canExpand: boolean;
  children: (expanded: boolean) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenView = useRef<HTMLDivElement>(null);
  return (
    <Dialog open={fullscreen} onOpenChange={setFullscreen}>
      <Panel testId={testId} className="space-y-2">
        <header className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1 text-sm font-medium">{heading ?? title}</div>
          {canExpand && (
            <>
              <button
                type="button"
                data-testid="chat-ui-expand"
                aria-label={`${expanded ? "Collapse" : "Expand"} ${title}`}
                aria-expanded={expanded}
                className="min-h-11 shrink-0 rounded px-2 text-xs text-muted-foreground hover:bg-surface focus-visible:outline-2 focus-visible:outline-focus sm:min-h-8"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? "Collapse" : "Expand"}
              </button>
              <DialogTrigger asChild>
                <button
                  type="button"
                  data-testid="chat-ui-fullscreen"
                  aria-label={`View ${title} fullscreen`}
                  className="flex size-11 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-surface focus-visible:outline-2 focus-visible:outline-focus sm:size-8"
                >
                  <Maximize2 size={15} aria-hidden="true" />
                </button>
              </DialogTrigger>
            </>
          )}
        </header>
        {!fullscreen && children(expanded)}
      </Panel>
      <DialogContent
        ref={fullscreenView}
        data-testid="chat-ui-fullscreen-dialog"
        className="left-0 flex w-screen max-w-none max-h-none translate-x-0 translate-y-0 flex-col gap-3 overflow-hidden rounded-none p-4 sm:rounded-none sm:p-6 [&>button]:size-11"
        style={{ top: "var(--app-top, 0px)", height: "var(--app-height, 100dvh)" }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          fullscreenView.current?.focus();
        }}
        onClick={(event) => {
          if (!(event.target instanceof Element)) return;
          const href = event.target.closest("a")?.getAttribute("href");
          if (href?.startsWith("/") && !href.startsWith("//")) setFullscreen(false);
        }}
      >
        <DialogTitle className="min-w-0 pr-12 break-words">{heading ?? title}</DialogTitle>
        <DialogDescription className="sr-only">
          Full current content. Press Escape or Close to return to chat.
        </DialogDescription>
        <div
          className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain"
          data-testid="chat-ui-fullscreen-content"
        >
          {fullscreen && children(true)}
        </div>
        {fullscreen && <ChatUiActionFeedback />}
      </DialogContent>
    </Dialog>
  );
}
