import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { workspaceSection } from "@/lib/workspace-navigation";

interface ViewHeaderProps {
  title: string;
  action?: ReactNode;
  meta?: ReactNode;
  level?: 1 | 2;
}

export function ViewHeader({ title, action, meta, level = 1 }: ViewHeaderProps) {
  const { pathname } = useLocation();
  const Heading = level === 2 ? "h2" : "h1";
  // The section tab bar already names the page; keep the heading for screen readers only.
  const tabbed = level === 1 && (workspaceSection(pathname)?.pages.length ?? 0) > 1;
  const heading = (
    <Heading
      data-testid={level === 2 ? "section-title" : "view-title"}
      className={
        tabbed ? "sr-only" : "font-headline font-medium text-2xl tracking-tight text-on-surface"
      }
    >
      {title}
    </Heading>
  );
  if (tabbed && !meta && !action) return heading;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
      <div className="flex min-w-0 flex-col gap-1">
        {heading}
        {meta && (
          <span data-testid="view-meta" className="font-body text-sm text-outline">
            {meta}
          </span>
        )}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}
