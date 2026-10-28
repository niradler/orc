import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useBlocker } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Long configuration forms keep their actions visible and protect an unfinished draft. */
export function FormDialog(props: Parameters<typeof ActiveFormDialog>[0]) {
  // Register only the visible form: the router supports one active navigation blocker.
  return props.open ? <ActiveFormDialog {...props} /> : null;
}
function ActiveFormDialog({
  open,
  dirty,
  busy = false,
  onClose,
  onDiscard,
  testId = "form-dialog",
  children,
}: {
  open: boolean;
  dirty: boolean;
  busy?: boolean;
  onClose: () => void;
  onDiscard?: () => void;
  testId?: string;
  children: (requestClose: () => void, closeAfterSave: () => void) => ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  const descriptionId = useId();
  const keepEditing = useRef<HTMLButtonElement>(null);
  const discarding = useRef(false);
  const previousOpen = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const committed = useRef(false);
  const blocker = useBlocker(() => open && (dirty || busy) && !committed.current);
  useEffect(() => {
    if (busy) return;
    const alert = content.current?.querySelector('[role="alert"]');
    if (alert instanceof HTMLElement) alert.scrollIntoView({ block: "nearest" });
  }, [busy]);
  useEffect(() => {
    if (blocker.state === "blocked") {
      discarding.current = false;
      setConfirming(true);
    }
  }, [blocker.state]);
  useEffect(() => {
    if (!open || (!dirty && !busy)) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (committed.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [open, dirty, busy]);
  const keepDraft = () => {
    if (blocker.state === "blocked") blocker.reset();
    setConfirming(false);
  };
  const closeAfterSave = () => {
    committed.current = true;
    if (blocker.state === "blocked") blocker.reset();
    onClose();
  };
  if (open && !previousOpen.current)
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  previousOpen.current = open;
  const requestClose = () => {
    if (busy) return;
    if (dirty) {
      discarding.current = false;
      setConfirming(true);
    } else onClose();
  };
  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && requestClose()}>
        <DialogContent
          ref={content}
          data-testid={testId}
          closeDisabled={busy}
          aria-busy={busy}
          className="work-form-dialog flex w-[min(960px,calc(100vw-3rem))] max-w-none flex-col gap-0 overflow-hidden p-0 max-sm:h-[var(--app-height,100dvh)] max-sm:max-h-[var(--app-height,100dvh)] max-sm:w-full max-sm:rounded-none max-sm:border-0"
          onCloseAutoFocus={(event) => {
            if (!opener.current?.isConnected) return;
            event.preventDefault();
            opener.current.focus();
          }}
        >
          {children(requestClose, closeAfterSave)}
        </DialogContent>
      </Dialog>
      <Dialog open={confirming} onOpenChange={(next) => (next ? setConfirming(true) : keepDraft())}>
        <DialogContent
          className="max-w-sm"
          aria-describedby={descriptionId}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            keepEditing.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            if (!discarding.current || !opener.current?.isConnected) return;
            event.preventDefault();
            opener.current.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription id={descriptionId}>
              {busy
                ? "Saving changes. Wait for this operation to finish."
                : "Your form has unsaved changes."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              data-testid="discard-form-changes"
              disabled={busy}
              onClick={() => {
                discarding.current = true;
                committed.current = true;
                setConfirming(false);
                onDiscard?.();
                onClose();
                if (blocker.state === "blocked") blocker.proceed();
              }}
            >
              Discard changes
            </Button>
            <Button ref={keepEditing} data-testid="keep-editing" onClick={keepDraft}>
              Keep editing
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
