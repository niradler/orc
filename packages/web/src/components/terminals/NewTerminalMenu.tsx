import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TerminalKind } from "@/api/client";
import { TERMINAL_KINDS } from "@/lib/terminal-kinds";
import { cn } from "@/lib/utils";

interface NewTerminalMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  launchers: TerminalKind[];
  pending: boolean;
  error: string | null;
  onCreate: (kind: TerminalKind, cwd: string) => void;
  className?: string;
}

export function NewTerminalMenu({
  open,
  onOpenChange,
  launchers,
  pending,
  error,
  onCreate,
  className,
}: NewTerminalMenuProps) {
  const [cwd, setCwd] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        data-testid="terminal-new"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-sm bg-primary/15 border border-primary/30 text-primary font-label text-xs uppercase tracking-widest hover:bg-primary/25 transition-colors"
      >
        <Plus size={14} />
        New terminal
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 right-0 top-full mt-1 z-30 min-w-56 bg-surface border border-surface-highest rounded-sm shadow-xl p-2 space-y-2"
        >
          <label className="block">
            <span className="font-label text-[10px] uppercase tracking-widest text-outline">
              Working directory
            </span>
            <input
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="default"
              spellCheck={false}
              className="mt-1 w-full bg-surface-low border border-surface-highest rounded-sm px-2 py-1 font-body text-xs text-on-surface placeholder:text-outline focus:outline-none focus:ring-1 focus:ring-primary/40"
            />
          </label>
          <div className="space-y-0.5">
            {launchers.map((kind) => {
              const { label, icon: Icon } = TERMINAL_KINDS[kind];
              return (
                <button
                  key={kind}
                  type="button"
                  role="menuitem"
                  disabled={pending}
                  onClick={() => onCreate(kind, cwd.trim())}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm font-label text-xs uppercase tracking-widest text-on-surface-variant hover:bg-surface-highest hover:text-on-surface disabled:opacity-50"
                >
                  <Icon size={14} />
                  {label}
                </button>
              );
            })}
            {launchers.length === 0 && (
              <p className="px-2 py-1 font-body text-xs text-outline">No launchers available</p>
            )}
          </div>
          {error && (
            <p role="alert" className="px-1 font-body text-xs text-error break-words">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
