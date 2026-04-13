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
  primary: "text-primary terminal-glow",
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
  return (
    <div
      data-testid="stat-card"
      data-stat-label={label}
      className={cn(
        "bg-surface-low p-4 rounded-sm border-l-2 relative overflow-hidden",
        ACCENT_COLORS[accent],
        onClick && "cursor-pointer hover:bg-surface transition-colors",
      )}
      onClick={onClick}
    >
      <div className="flex justify-between items-start mb-2">
        <span className="font-label text-[10px] text-outline uppercase tracking-widest">
          {label}
        </span>
      </div>
      <div
        data-testid="stat-card-value"
        className={cn("text-2xl font-headline font-extrabold uppercase", VALUE_COLORS[accent])}
      >
        {value}
      </div>
      {sub && <div className="font-label text-[10px] text-outline mt-1">{sub}</div>}
    </div>
  );
}
