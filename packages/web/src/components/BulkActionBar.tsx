import { type ReactElement, type ReactNode, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

export function BulkActionBar({
  count,
  allSelected,
  someSelected,
  onSelectAll,
  onClear,
  disabled,
  children,
  resourceLabel = "entries",
}: {
  count: number;
  allSelected: boolean;
  someSelected: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  disabled?: boolean;
  children: ReactNode;
  resourceLabel?: string;
}): ReactElement {
  const checkbox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (checkbox.current) checkbox.current.indeterminate = someSelected;
  }, [someSelected]);
  return (
    <fieldset
      className="mb-3 flex flex-wrap items-center gap-2 border-y border-border py-1"
      data-testid="bulk-actions"
      aria-label="List selection and actions"
    >
      <label className="flex min-h-11 items-center gap-2 text-[13px] sm:min-h-8">
        <input
          ref={checkbox}
          type="checkbox"
          data-testid="select-all-rows"
          aria-label={`Select all displayed ${resourceLabel}`}
          checked={allSelected}
          disabled={disabled}
          onChange={() => (allSelected ? onClear() : onSelectAll())}
          className="size-4 accent-primary"
        />
        {count ? `${count} selected` : `Select displayed ${resourceLabel}`}
      </label>
      {count > 0 && (
        <>
          {children}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClear}
            disabled={disabled}
            data-testid="clear-selection"
          >
            Clear selection
          </Button>
        </>
      )}
    </fieldset>
  );
}
