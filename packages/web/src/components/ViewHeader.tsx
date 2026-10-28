import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { HelpPopover } from "@/components/HelpPopover";
import { workspaceSection } from "@/lib/workspace-navigation";

interface ViewHeaderProps {
  title: string;
  action?: ReactNode;
  meta?: ReactNode;
  level?: 1 | 2;
  help?: ReactNode;
  compact?: boolean;
}

export function ViewHeader({
  title,
  action,
  meta,
  level = 1,
  help,
  compact = true,
}: ViewHeaderProps) {
  const { pathname } = useLocation();
  const Heading = level === 2 ? "h2" : "h1";
  // The section tab bar already names the page; keep the heading for screen readers only.
  const tabbed = !compact && level === 1 && (workspaceSection(pathname)?.pages.length ?? 0) > 1;
  const heading = (
    <Heading
      data-testid={level === 2 ? "section-title" : "view-title"}
      className={
        tabbed
          ? "sr-only"
          : compact
            ? "font-headline text-base font-medium text-on-surface"
            : "font-headline font-medium text-2xl tracking-tight text-on-surface"
      }
    >
      {title}
    </Heading>
  );
  if (tabbed && !meta && !action) return heading;
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-2 ${compact ? "mb-3" : "mb-6"}`}
    >
      <div
        className={
          compact ? "flex min-w-0 flex-wrap items-center gap-x-1" : "flex min-w-0 flex-col gap-1"
        }
      >
        {heading}
        {meta !== undefined && meta !== null && (
          <span data-testid="view-meta" className="font-body text-sm text-outline">
            {compact && <span aria-hidden>· </span>}
            {meta}
          </span>
        )}
        {help && <HelpPopover label={title}>{help}</HelpPopover>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}
