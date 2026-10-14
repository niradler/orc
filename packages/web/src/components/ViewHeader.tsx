import type { ReactNode } from "react";

interface ViewHeaderProps {
  title: string;
  action?: ReactNode;
  meta?: ReactNode;
  level?: 1 | 2;
}

export function ViewHeader({ title, action, meta, level = 1 }: ViewHeaderProps) {
  const Heading = level === 2 ? "h2" : "h1";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
      <div className="flex min-w-0 flex-col gap-1">
        <Heading
          data-testid={level === 2 ? "section-title" : "view-title"}
          className="font-headline font-medium text-2xl tracking-tight text-on-surface"
        >
          {title}
        </Heading>
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
