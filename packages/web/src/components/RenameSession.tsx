import { useState } from "react";
import type { LiveSession } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useUpdateLiveSession } from "@/hooks/useSessions";

export function RenameSession({
  session,
  open,
  onClose,
  onSaved,
}: {
  session: LiveSession;
  open: boolean;
  onClose: () => void;
  onSaved?: (title: string | null) => void;
}) {
  const update = useUpdateLiveSession();
  const [name, setName] = useState(session.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const saved = session.name ?? "";
  const trimmed = name.trim();

  async function save(title: string | null): Promise<void> {
    setError(null);
    try {
      await update.mutateAsync({ id: session.id, display_title: title });
      onSaved?.(title);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (update.isPending) return;
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>Rename session</DialogTitle>
        <DialogDescription>
          The name stays after a restart and a re-sync. The agent keeps its own title.
        </DialogDescription>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (update.isPending || !trimmed) return;
            void save(trimmed);
          }}
        >
          <label htmlFor={`session-name-${session.id}`} className="block space-y-2">
            <span className="text-sm">Session name</span>
            <Input
              id={`session-name-${session.id}`}
              data-testid="session-rename-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
              required
              disabled={update.isPending}
            />
          </label>
          {error && (
            <p role="alert" data-testid="session-rename-error" className="text-sm text-error">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {session.renamed && (
              <Button
                type="button"
                variant="ghost"
                data-testid="session-rename-reset"
                disabled={update.isPending}
                onClick={() => void save(null)}
              >
                Use agent title
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              data-testid="session-rename-cancel"
              disabled={update.isPending}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              data-testid="session-rename-save"
              disabled={update.isPending || !trimmed || trimmed === saved}
            >
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
