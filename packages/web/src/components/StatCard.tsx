import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Accent = "primary" | "secondary" | "tertiary" | "error" | "muted";

const ACCENT_COLORS: Record<Accent, string> = {
  primary: "border-l-primary",
  secondary: "border-l-secondary",
  tertiary: "border-l-tertiary",
  error: "border-l-error",
  muted: "border-l-outline-variant",
};

const VALUE_COLORS: Record<Accent, string> = {
  primary: "text-primary",
  secondary: "text-secondary",
  tertiary: "text-tertiary",
  error: "text-error",
  muted: "text-on-surface-variant",
};

interface StatCardProps {
  label: string;
  value: ReactNode;
  accent?: Accent;
  sub?: string;
  onClick?: () => void;
}

export function StatCard({ label, value, accent = "muted", sub, onClick }: StatCardProps) {
  const classes = cn(
    "bg-surface p-5 rounded-xl border border-border border-l-2 relative overflow-hidden text-left w-full block",
    ACCENT_COLORS[accent],
    onClick && "cursor-pointer hover:bg-surface transition-colors",
  );
  const inner = (
    <>
      <div className="flex justify-between items-start mb-2">
        <span className="font-label text-sm text-outline">{label}</span>
      </div>
      <div
        data-testid="stat-card-value"
        className={cn("text-3xl font-headline font-medium tabular-nums", VALUE_COLORS[accent])}
      >
        {value}
      </div>
      {sub && <div className="font-label text-xs text-outline mt-1">{sub}</div>}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        data-testid="stat-card"
        data-stat-label={label}
        className={classes}
        onClick={onClick}
      >
        {inner}
      </button>
    );
  }
  return (
    <div data-testid="stat-card" data-stat-label={label} className={classes}>
      {inner}
    </div>
  );
}
