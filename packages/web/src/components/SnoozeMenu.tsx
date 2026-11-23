import type { HumanRequestSnoozeInput } from "@orc/core/human-requests";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ArrowLeft, BellRing, Clock, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import {
  formatSnoozeUntil,
  parseDatetimeLocalValue,
  SNOOZE_PRESETS,
  toDatetimeLocalValue,
  tomorrowAtNine,
} from "@/lib/snooze";
import { cn } from "@/lib/utils";

type SnoozeChoice = Omit<HumanRequestSnoozeInput, "version">;

export function SnoozeMenu({
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  disabled,
  onSelect,
  trigger,
  align = "start",
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  onSelect: (choice: SnoozeChoice) => void;
  trigger?: ReactNode;
  align?: "start" | "center" | "end";
}) {
  const desktop = useBreakpoint("md");
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    controlledOnOpenChange?.(next);
    if (controlledOpen === undefined) setInternalOpen(next);
  };
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState(() =>
    toDatetimeLocalValue(Date.now() + 2 * 60 * 60 * 1000),
  );
  const [customError, setCustomError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setCustomOpen(false);
      setCustomError(null);
    } else {
      setCustomValue(toDatetimeLocalValue(Date.now() + 2 * 60 * 60 * 1000));
    }
  }, [open]);

  const choose = (choice: SnoozeChoice) => {
    setOpen(false);
    onSelect(choice);
  };

  const submitCustom = () => {
    const parsed = parseDatetimeLocalValue(customValue);
    if (!parsed || parsed <= Date.now()) {
      setCustomError("Choose a future date and time.");
      return;
    }
    setCustomError(null);
    choose({ until: parsed });
  };

  const optionRowClass = cn(
    "flex w-full items-center justify-between gap-2 rounded-md px-2.5 text-left text-sm text-on-surface hover:bg-surface focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50 pointer-coarse:min-h-11",
    desktop ? "min-h-8 py-1.5 text-[13px]" : "min-h-11 py-2.5 text-sm",
  );

  const body = customOpen ? (
    <div data-testid="snooze-custom-form" className="space-y-2.5 p-1">
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Back to snooze presets"
          className={
            desktop ? "size-7 pointer-coarse:min-h-11 pointer-coarse:min-w-11" : "min-h-11 min-w-11"
          }
          onClick={() => {
            setCustomOpen(false);
            setCustomError(null);
          }}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <span className="text-xs font-medium text-on-surface">Custom snooze time</span>
      </div>
      <label className="block space-y-1">
        <span className="sr-only">Snooze until date and time</span>
        <input
          type="datetime-local"
          data-testid="snooze-custom-input"
          value={customValue}
          min={toDatetimeLocalValue(Date.now() + 60_000)}
          onChange={(event) => {
            setCustomValue(event.target.value);
            setCustomError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              submitCustom();
            }
          }}
          className="min-h-11 w-full rounded-md border border-control-border bg-background px-2.5 text-base text-on-surface focus-visible:outline-2 focus-visible:outline-focus md:min-h-8 md:text-sm pointer-coarse:min-h-11 pointer-coarse:text-base"
        />
      </label>
      {customError && (
        <p role="alert" data-testid="snooze-custom-error" className="text-xs text-error">
          {customError}
        </p>
      )}
      <div className="flex items-center justify-end gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="max-md:min-h-11 pointer-coarse:min-h-11"
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid="snooze-custom-submit"
          disabled={disabled}
          className="max-md:min-h-11 pointer-coarse:min-h-11"
          onClick={(event) => {
            event.stopPropagation();
            submitCustom();
          }}
        >
          Snooze
        </Button>
      </div>
    </div>
  ) : (
    <div className="space-y-0.5" role="menu" aria-label="Snooze options">
      {SNOOZE_PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          role="menuitem"
          data-testid={`snooze-option-${preset.id}`}
          disabled={disabled}
          className={optionRowClass}
          onClick={() => choose({ after_seconds: preset.afterSeconds })}
        >
          <span>{preset.label}</span>
          <span className="text-xs text-muted-foreground">{preset.shortLabel}</span>
        </button>
      ))}
      <button
        type="button"
        role="menuitem"
        data-testid="snooze-option-tomorrow"
        disabled={disabled}
        className={optionRowClass}
        onClick={() => choose({ until: tomorrowAtNine() })}
      >
        <span>Tomorrow 9:00</span>
        <span className="text-xs text-muted-foreground">09:00</span>
      </button>
      <div className="my-1 border-t border-border" />
      <button
        type="button"
        role="menuitem"
        data-testid="snooze-option-custom"
        disabled={disabled}
        className={optionRowClass}
        onClick={() => setCustomOpen(true)}
      >
        <span>Custom…</span>
      </button>
    </div>
  );

  if (desktop) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        {trigger && <PopoverTrigger asChild>{trigger}</PopoverTrigger>}
        <PopoverContent
          align={align}
          data-testid="snooze-menu"
          data-presentation="popover"
          aria-label="Snooze request"
          className="z-[80] w-60 p-1.5"
        >
          {body}
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      {trigger && <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[75] bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          data-testid="snooze-menu"
          data-presentation="sheet"
          aria-describedby={undefined}
          className="fixed inset-x-0 bottom-0 z-[80] max-h-[85dvh] w-full max-w-full overflow-y-auto rounded-t-xl border-t border-border bg-surface-high p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-lg focus:outline-none"
        >
          <div className="mb-2 flex items-center justify-between gap-2 border-b border-border pb-2">
            <DialogPrimitive.Title className="flex items-center gap-1.5 text-sm font-medium text-on-surface">
              <Clock className="size-4 text-muted-foreground" aria-hidden="true" />
              Snooze request
            </DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Close snooze menu"
                className="min-h-11 min-w-11"
              >
                <X className="size-4" />
              </Button>
            </DialogPrimitive.Close>
          </div>
          {body}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function SnoozedWaitingBanner({
  until,
  busy,
  onWake,
  error,
  compact = false,
  className,
}: {
  until: number;
  busy?: boolean;
  onWake: () => void;
  error?: string | null;
  compact?: boolean;
  className?: string;
}) {
  const formatted = formatSnoozeUntil(until);
  return (
    <div
      data-testid="session-snoozed-banner"
      role="status"
      className={cn(
        "flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-border bg-surface text-xs text-on-surface",
        compact ? "rounded-md border px-2.5 py-1.5" : "px-4 py-2 sm:px-6",
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Clock className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
        <span className="truncate">
          Waiting for you · snoozed until{" "}
          <time dateTime={new Date(until).toISOString()} title={new Date(until).toLocaleString()}>
            {formatted}
          </time>
        </span>
      </span>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        data-testid="session-wake-now"
        disabled={busy}
        className="max-md:min-h-11 pointer-coarse:min-h-11 shrink-0"
        onClick={onWake}
      >
        <BellRing className="size-3.5" aria-hidden="true" />
        {busy ? "Waking…" : "Wake now"}
      </Button>
      {error && (
        <p role="alert" className="w-full text-xs text-error">
          {error}
        </p>
      )}
    </div>
  );
}
