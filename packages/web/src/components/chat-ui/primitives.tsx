import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { cn } from "../../lib/utils";

export type Tone = "neutral" | "progress" | "success" | "warning" | "error";

export const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-muted-foreground",
  progress: "bg-progress",
  success: "bg-secondary",
  warning: "bg-tertiary",
  error: "bg-error",
};

/** Dashboard links keep a docked chat open, matching workspace navigation. */
export function chatUiHref(href: string, currentSearch: string): string {
  if (!href.startsWith("/")) return href;
  const current = new URLSearchParams(currentSearch);
  if (current.get("chat") !== "open") return href;
  const target = new URL(href, "http://orc.local");
  const query = target.searchParams;
  query.set("chat", "open");
  const thread = current.get("chatThread");
  if (thread) query.set("chatThread", thread);
  return `${target.pathname}?${query}${target.hash}`;
}

export function UiLink({
  href,
  children,
  className,
  testId,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const location = useLocation();
  const classes = cn(
    "inline-flex min-w-0 items-center text-on-surface underline decoration-outline-variant underline-offset-4 hover:decoration-current focus-visible:outline-2 focus-visible:outline-focus",
    className,
  );
  if (href.startsWith("/"))
    return (
      <Link data-testid={testId} to={chatUiHref(href, location.search)} className={classes}>
        {children}
      </Link>
    );
  return (
    <a
      data-testid={testId}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={classes}
    >
      {children}
    </a>
  );
}

export function Dot({ tone, className }: { tone: Tone; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone], className)}
    />
  );
}

/** Bordered container shared by Card and the live entity components. */
export function Panel({
  children,
  className,
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section
      data-testid={testId}
      className={cn("min-w-0 rounded-lg border border-outline-variant px-3 py-2.5", className)}
    >
      {children}
    </section>
  );
}

export function Meta({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-variant">
      {children}
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className="h-14 animate-pulse rounded-lg border border-outline-variant bg-surface"
    />
  );
}

export function Failure({ label, error }: { label: string; error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div
      role="alert"
      data-testid="chat-ui-entity-error"
      className="rounded-lg border border-outline-variant px-3 py-2 text-xs text-on-surface-variant"
    >
      <span className="text-error">{label}</span> {message}
    </div>
  );
}

export function Rows({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <ul data-testid={testId} className="min-w-0 divide-y divide-outline-variant">
      {children}
    </ul>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-2 text-xs text-on-surface-variant">{children}</p>;
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
        aria-label={label ?? "Progress"}
        className="h-1 flex-1 overflow-hidden rounded-full bg-selected"
      >
        <div className="h-full rounded-full bg-progress" style={{ width: `${clamped}%` }} />
      </div>
      <span className="shrink-0 text-xs tabular-nums text-on-surface-variant">
        {label ? `${label} · ` : ""}
        {clamped}%
      </span>
    </div>
  );
}

export function when(value: string | number | null | undefined): string {
  if (value == null) return "—";
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
