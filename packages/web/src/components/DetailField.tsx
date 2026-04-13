import { cn } from "@/lib/utils";

interface DetailFieldProps {
  label: string;
  children: React.ReactNode;
  className?: string;
}

export function DetailField({ label, children, className }: DetailFieldProps) {
  return (
    <div className={cn("space-y-0.5", className)}>
      <div className="font-label text-[10px] uppercase tracking-widest text-outline">{label}</div>
      <div className="font-body text-xs text-on-surface">{children}</div>
    </div>
  );
}
