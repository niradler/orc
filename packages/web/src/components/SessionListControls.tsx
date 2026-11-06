import { ArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import { SESSION_FILTER_LABELS, SESSION_FILTERS, type SessionFilter } from "@/lib/session-filter";
import { cn } from "@/lib/utils";

export function SessionStateFilters({
  value,
  counts,
  onChange,
  className,
  children,
}: {
  value: SessionFilter;
  counts: Record<SessionFilter, number>;
  onChange: (filter: SessionFilter) => void;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-1 max-sm:gap-0.5", className)}>
      <fieldset
        aria-label="Filter sessions by state"
        data-testid="session-filters"
        className="flex min-w-0 flex-1 flex-wrap gap-1 max-sm:gap-0.5"
      >
        {SESSION_FILTERS.map((filter) => (
          <button
            key={filter}
            type="button"
            data-testid={`session-filter-${filter}`}
            aria-pressed={value === filter}
            onClick={() => onChange(filter)}
            className={cn(
              "inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs whitespace-nowrap max-lg:min-h-11 max-sm:gap-1 max-sm:px-1.5",
              value === filter
                ? "bg-surface-highest text-on-surface"
                : "text-muted-foreground hover:bg-surface",
            )}
          >
            {SESSION_FILTER_LABELS[filter]}
            <span
              data-testid="session-filter-count"
              className={cn(
                "tabular-nums",
                filter === "needs-you" && counts[filter] ? "text-warning" : "text-outline",
              )}
            >
              {counts[filter]}
            </span>
          </button>
        ))}
      </fieldset>
      {children}
    </div>
  );
}

/** Sits beside the filters, never over a row, so reaching it keeps the list frozen. */
export function StableOrderPill({ pending, onApply }: { pending: number; onApply: () => void }) {
  if (pending <= 0) return null;
  return (
    <button
      type="button"
      data-testid="stable-order-pill"
      onClick={onApply}
      className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs whitespace-nowrap text-primary hover:bg-surface max-lg:min-h-11 max-sm:px-1.5"
    >
      <ArrowUp aria-hidden="true" size={12} />
      {pending}
      <span className="max-sm:sr-only"> updated</span>
    </button>
  );
}
