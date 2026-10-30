import * as Popover from "@radix-ui/react-popover";
import { CopyPlus, Ellipsis, Pencil, X } from "lucide-react";
import { useState } from "react";
import type { Terminal } from "@/api/client";

type TerminalActionsProps = {
  terminal: Terminal;
  onRename: (terminal: Terminal) => void;
  onDuplicate: (terminal: Terminal) => void;
  onClose: (terminal: Terminal) => void;
  canDuplicate: boolean;
  pending: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function TerminalActions({
  terminal,
  onRename,
  onDuplicate,
  onClose,
  canDuplicate,
  pending,
  open,
  onOpenChange,
}: TerminalActionsProps) {
  const [localOpen, setLocalOpen] = useState(false);
  const setOpen = onOpenChange ?? setLocalOpen;
  const itemClass =
    "flex w-full items-center gap-2 rounded px-3 min-h-8 text-[13px] text-left hover:bg-surface-highest focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40";
  return (
    <Popover.Root open={open ?? localOpen} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-testid="terminal-actions"
          data-terminal-actions={terminal.id}
          aria-label={`Actions for ${terminal.name}`}
          title="Terminal actions (also right-click the tab)"
          className="shrink-0 inline-flex min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 items-center justify-center rounded text-on-surface-variant hover:bg-surface hover:text-on-surface"
        >
          <Ellipsis size={16} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          data-testid="terminal-actions-menu"
          aria-label={`Actions for ${terminal.name}`}
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 w-64 max-w-[calc(100vw-16px)] rounded-md border border-outline-variant bg-surface-high p-1 shadow-lg"
        >
          <p className="truncate px-3 py-2 text-xs text-on-surface-variant" title={terminal.name}>
            {terminal.name}
          </p>
          <button
            type="button"
            data-testid="terminal-rename"
            onClick={() => {
              setOpen(false);
              onRename(terminal);
            }}
            className={itemClass}
          >
            <Pencil size={14} />
            Rename
          </button>
          <button
            type="button"
            data-testid="terminal-duplicate"
            disabled={pending || !canDuplicate}
            onClick={() => {
              setOpen(false);
              onDuplicate(terminal);
            }}
            className={itemClass}
            title={
              canDuplicate
                ? "Start a fresh session of the same type in this folder"
                : "The session's host or launcher is unavailable"
            }
          >
            <CopyPlus size={14} />
            Duplicate tab
          </button>
          <p className="px-3 pb-2 text-xs text-on-surface-variant">
            Duplicate starts a fresh session in the same folder.
          </p>
          <div className="border-t border-outline-variant pt-1">
            <button
              type="button"
              data-testid="terminal-close-selected"
              onClick={() => {
                setOpen(false);
                onClose(terminal);
              }}
              className={`${itemClass} text-error`}
            >
              <X size={14} />
              Close terminal
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
