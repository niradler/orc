import { useState } from "react";
import type { LinkSafetyModalProps } from "streamdown";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Participate in the same focus and pointer-event stack as the containing chat or sheet. */
export function MarkdownLinkDialog({ isOpen, onClose, onConfirm, url }: LinkSafetyModalProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-streamdown="link-safety-modal"
        data-testid="markdown-link-dialog"
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          onClose();
        }}
      >
        <DialogHeader>
          <DialogTitle>Open external link?</DialogTitle>
          <DialogDescription>You’re about to visit an external website.</DialogDescription>
        </DialogHeader>
        <p className="max-h-32 overflow-y-auto break-all rounded-md bg-muted p-3 font-mono text-sm">
          {url}
        </p>
        {copyError && (
          <p role="status" className="text-sm text-destructive">
            Could not copy link.
          </p>
        )}
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(url);
                setCopied(true);
                setCopyError(false);
              } catch {
                setCopyError(true);
              }
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
          <Button
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            Open link
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
