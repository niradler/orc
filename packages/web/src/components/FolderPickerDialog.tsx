import { type RefObject, useRef } from "react";
import { RemoteFolderBrowser } from "@/components/terminals/RemoteFolderBrowser";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { FolderPickerSession } from "@/hooks/useFolderPickerSession";

export function FolderPickerDialog({
  open,
  onOpenChange,
  host,
  initial,
  onPick,
  returnFocusRef,
  session,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  host: string | null;
  initial: string;
  onPick: (path: string) => void;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
  session?: FolderPickerSession;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const logicalOpen = useRef({ open: false, id: 0 });
  if (open && !logicalOpen.current.open) logicalOpen.current.id++;
  logicalOpen.current.open = open;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={contentRef}
        data-testid="folder-picker-dialog"
        className="flex w-[calc(100vw-1.5rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0 [&>button:last-child]:size-11 sm:[&>button:last-child]:size-8 [@media(pointer:coarse)]:[&>button:last-child]:size-11"
        onEscapeKeyDown={(event) => {
          if (event.target instanceof HTMLInputElement && event.target.name === "folder-address") {
            event.preventDefault();
            return;
          }
          event.stopPropagation();
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocusRef?.current) {
            event.preventDefault();
            returnFocusRef.current.focus();
          }
        }}
      >
        <div className="shrink-0 border-b border-border px-4 py-3 pr-12">
          <DialogTitle>Choose folder</DialogTitle>
          <DialogDescription className="mt-1 truncate text-xs" title={host ?? "API host"}>
            Folders on {host ?? "the API host"}
          </DialogDescription>
        </div>
        <RemoteFolderBrowser
          key={logicalOpen.current.id}
          session={session}
          host={host}
          initial={initial}
          onClose={() => onOpenChange(false)}
          onPick={(path) => {
            onPick(path);
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
