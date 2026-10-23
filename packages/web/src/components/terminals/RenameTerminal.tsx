import { useState } from "react";
import type { Terminal } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useTerminals } from "@/lib/terminals";

export function RenameTerminal({ terminal, onClose }: { terminal: Terminal; onClose: () => void }) {
  const { rename } = useTerminals();
  const [name, setName] = useState(terminal.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document
            .querySelector<HTMLButtonElement>(
              `[data-terminal-actions="${CSS.escape(terminal.id)}"]`,
            )
            ?.focus();
        }}
      >
        <DialogTitle>Rename terminal</DialogTitle>
        <DialogDescription>Choose a friendly name for this terminal session.</DialogDescription>
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (pending || !name.trim()) return;
            setPending(true);
            setError(null);
            try {
              await rename(terminal.id, name.trim());
              onClose();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setPending(false);
            }
          }}
        >
          <label htmlFor={`terminal-name-${terminal.id}`} className="block space-y-2">
            <span className="text-sm">Terminal name</span>
            <Input
              id={`terminal-name-${terminal.id}`}
              data-testid="terminal-rename-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              required
              disabled={pending}
            />
          </label>
          {error && (
            <p role="alert" data-testid="terminal-rename-error" className="text-sm text-error">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              data-testid="terminal-rename-cancel"
              disabled={pending}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              data-testid="terminal-rename-save"
              disabled={pending || !name.trim()}
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
