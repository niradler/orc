import { ChevronRight } from "lucide-react";
import { type ReactNode, useId } from "react";
import { cn } from "@/lib/utils";

/**
 * One line of knowledge base setup: a name, its current state and one action, on a shared grid so
 * every row lines up. Rows with management controls expand in place; plain settings do not.
 */
export function KbSetupRow({
  title,
  testId,
  toggleTestId,
  summary,
  actions,
  expanded = false,
  onExpandedChange,
  heading: Heading = "h3",
  compact = false,
  children,
}: {
  title: string;
  testId: string;
  toggleTestId?: string;
  summary: ReactNode;
  actions?: ReactNode;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  heading?: "h2" | "h3";
  /** Narrow side panels drop the fixed title and action columns. */
  compact?: boolean;
  children?: ReactNode;
}) {
  const id = useId();
  const expandable = children !== undefined && onExpandedChange !== undefined;
  return (
    <section
      data-testid={testId}
      data-expanded={expandable ? expanded : undefined}
      aria-labelledby={`${id}-heading`}
      className="min-w-0 text-sm"
    >
      <div
        className={cn(
          "grid min-h-12 min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 py-1.5",
          !compact && "sm:grid-cols-[9rem_minmax(0,1fr)_auto]",
        )}
      >
        <Heading id={`${id}-heading`} className="min-w-0 font-medium">
          {expandable ? (
            <button
              type="button"
              data-testid={toggleTestId}
              aria-expanded={expanded}
              aria-controls={id}
              className="-ml-1 flex min-h-9 items-center gap-1.5 rounded px-1 text-left hover:bg-surface-high"
              onClick={() => onExpandedChange(!expanded)}
            >
              <ChevronRight
                size={14}
                aria-hidden
                className={cn(
                  "shrink-0 text-outline transition-transform",
                  expanded && "rotate-90",
                )}
              />
              {title}
            </button>
          ) : (
            // Lines up with the chevron of expandable rows.
            <span className="flex min-h-9 items-center pl-5">{title}</span>
          )}
        </Heading>
        <div
          className={cn(
            "col-span-2 row-start-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-5",
            !compact && "sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:pl-0",
          )}
        >
          {summary}
        </div>
        <div
          className={cn(
            "col-start-2 row-start-1 flex items-center justify-end gap-1",
            !compact && "sm:col-start-3",
          )}
        >
          {actions}
        </div>
      </div>
      {expandable && expanded && (
        <div id={id} className="min-w-0 pb-4 pl-5 pt-1">
          {children}
        </div>
      )}
    </section>
  );
}

/** A status dot with its readable label, per DESIGN.md: never color alone. */
export function StateDot({ tone }: { tone: "ok" | "warning" | "error" | "off" | "progress" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        tone === "ok" && "bg-secondary",
        tone === "warning" && "bg-warning",
        tone === "error" && "bg-error",
        tone === "off" && "bg-muted-foreground",
        tone === "progress" && "bg-progress",
      )}
    />
  );
}
