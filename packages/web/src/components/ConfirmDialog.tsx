import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ConfirmDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title: string;
  description: string;
  confirmLabel?: string;
  variant?: "destructive" | "warning";
  isPending?: boolean;
}

export function ConfirmDialog({
  open,
  onConfirm,
  onCancel,
  title,
  description,
  confirmLabel = "Delete",
  variant = "destructive",
  isPending,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="bg-surface border-surface-highest max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-headline text-sm uppercase tracking-widest text-on-surface">
            {title}
          </DialogTitle>
          <DialogDescription className="font-body text-xs text-outline mt-2">
            {description}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            className="font-label text-xs uppercase text-outline"
          >
            Cancel
          </Button>
          <Button
            data-testid="confirm-dialog-confirm"
            type="button"
            size="sm"
            onClick={onConfirm}
            disabled={isPending}
            className={
              variant === "destructive"
                ? "font-label text-xs uppercase bg-error/15 text-error border border-error/30 hover:bg-error/25"
                : "font-label text-xs uppercase bg-tertiary/15 text-tertiary border border-tertiary/30 hover:bg-tertiary/25"
            }
          >
            {isPending ? "..." : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
