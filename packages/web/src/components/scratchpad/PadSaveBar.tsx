import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { PadDraft } from "./usePadDraft";

/** One toolbar row: view controls on the left, save state and actions on the right. */
export function PadSaveBar({ draft, children }: { draft: PadDraft; children?: ReactNode }) {
  const status = draft.saving ? "Saving…" : draft.dirty ? "Unsaved changes" : "Saved";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
        <span data-testid="scratchpad-save-status" role="status" className="text-xs text-outline">
          {status}
        </span>
        {(draft.dirty || draft.saving) && (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="scratchpad-discard"
              disabled={draft.saving}
              onClick={draft.discard}
            >
              Discard
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="scratchpad-save"
              disabled={draft.saving}
              onClick={() => void draft.save()}
            >
              Save
            </Button>
          </>
        )}
      </div>
      {draft.error && (
        <p role="alert" className="text-sm text-destructive">
          {draft.error} Your draft has been kept.
        </p>
      )}
      {draft.stale && !draft.error && (
        <p role="status" className="text-sm text-outline">
          This scratchpad changed elsewhere. Your draft is preserved; saving will check for
          conflicts.
        </p>
      )}
    </div>
  );
}

export function ModeButton({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex min-h-9 items-center gap-1.5 font-label text-sm px-3 py-1.5 border transition-colors ${
        active
          ? "bg-surface-highest text-on-surface border-transparent"
          : "bg-transparent border-transparent text-muted-foreground hover:bg-surface-low hover:text-on-surface"
      }`}
    >
      {children}
    </button>
  );
}
