import type { ReactNode } from "react";

interface ViewHeaderProps {
  title: string;
  action?: ReactNode;
  meta?: ReactNode;
}

export function ViewHeader({ title, action, meta }: ViewHeaderProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
        <h1
          data-testid="view-title"
          className="font-headline font-extrabold text-sm uppercase tracking-widest text-on-surface"
        >
          {title}
        </h1>
        {meta && (
          <span
            data-testid="view-meta"
            className="font-label text-[11px] text-outline uppercase tracking-widest"
          >
            {meta}
          </span>
        )}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}
