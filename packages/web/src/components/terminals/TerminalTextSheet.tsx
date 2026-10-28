import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { copyText } from "@/lib/terminal-runtime";

/**
 * The terminal's text as a native, selectable page, so a phone's own handles, loupe and Copy
 * work across the scrollback.
 */
export function TerminalTextSheet({ text, onClose }: { text: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent data-testid="terminal-text-sheet" defaultWidth={720} resizeKey="terminal-text">
        <SheetHeader className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <SheetTitle>Terminal text</SheetTitle>
            <SheetDescription>Select text to copy it, or copy everything.</SheetDescription>
          </div>
          <Button
            size="sm"
            onClick={() => {
              void copyText(text).then(() => setCopied(true));
            }}
          >
            {copied ? "Copied" : "Copy all"}
          </Button>
        </SheetHeader>
        <SheetBody
          ref={(body) => {
            if (body) body.scrollTop = body.scrollHeight;
          }}
        >
          <pre className="select-text whitespace-pre-wrap wrap-break-word font-mono text-xs text-on-surface">
            {text}
          </pre>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
