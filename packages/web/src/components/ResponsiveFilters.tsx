import { SlidersHorizontal } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ResponsiveFilters({
  children,
  activeCount = 0,
}: {
  children: ReactNode;
  activeCount?: number;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="contents">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0 lg:hidden"
        aria-expanded={open}
        aria-controls={id}
        data-testid="view-filters-toggle"
        onClick={() => setOpen(!open)}
      >
        <SlidersHorizontal aria-hidden />
        Filters{activeCount > 0 ? ` (${activeCount})` : ""}
      </Button>
      <div
        id={id}
        data-testid="view-filters"
        className={cn(
          "order-last w-full flex-wrap items-center gap-2 border-t border-border pt-3 lg:order-none lg:flex lg:w-auto lg:border-0 lg:pt-0",
          open ? "flex" : "hidden",
        )}
      >
        {children}
      </div>
    </div>
  );
}
