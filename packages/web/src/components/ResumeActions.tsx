import { Check, ChevronDown, Copy, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LiveSession } from "@/api/client";
import { resumeCommand } from "@/lib/live-sessions";
import { useTerminals } from "@/lib/terminals";
import { cn } from "@/lib/utils";

const SEGMENT =
  "inline-flex items-center gap-1 whitespace-nowrap px-2 py-1 font-label text-[11px] uppercase tracking-widest transition-colors";

export function ResumeActions({ session }: { session: LiveSession }) {
  const { openLiveSession, info } = useTerminals();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const command = resumeCommand(session);
  const menuOpen = menuPos !== null;

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuPos(null);
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menuOpen]);

  if (!command) return null;

  const open = () => {
    setPending(true);
    setError(null);
    openLiveSession(session)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed"))
      .finally(() => setPending(false));
  };

  const copy = () => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
    setMenuPos(null);
  };

  // Without terminals (no API secret, disabled, old Bun) the only useful action is the command.
  if (info && !info.ready) {
    return (
      <button
        type="button"
        data-testid="copy-resume"
        title={info.reason ?? command}
        className={cn(
          SEGMENT,
          "rounded-sm border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20",
        )}
        onClick={(e) => {
          e.stopPropagation();
          copy();
        }}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied ? "Copied" : "Copy resume command"}
      </button>
    );
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would add form-control chrome to a button group
    <div
      ref={rootRef}
      role="group"
      aria-label="Resume session"
      className="relative inline-flex items-stretch rounded-sm border border-primary/30 bg-primary/10"
    >
      <button
        type="button"
        data-testid="open-terminal-resume"
        disabled={pending}
        title={error ?? "Resume in an ORC terminal"}
        className={cn(
          SEGMENT,
          "rounded-l-sm disabled:opacity-50",
          error ? "text-error" : "text-primary hover:bg-primary/20",
        )}
        onClick={(e) => {
          e.stopPropagation();
          open();
        }}
      >
        <SquareTerminal className="h-3 w-3" />
        {error ? "Failed" : pending ? "Opening" : copied ? "Copied" : "Open in terminal"}
      </button>
      <button
        type="button"
        data-testid="resume-menu"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="More resume options"
        className={cn(SEGMENT, "px-1 border-l border-primary/30 text-primary hover:bg-primary/20")}
        onClick={(e) => {
          e.stopPropagation();
          if (menuOpen) return setMenuPos(null);
          const rect = e.currentTarget.parentElement?.getBoundingClientRect();
          if (rect) setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
        }}
      >
        <ChevronDown className="h-3 w-3" />
      </button>
      {menuPos && (
        <div
          role="menu"
          style={{ top: menuPos.top, right: menuPos.right }}
          className="fixed z-50 min-w-48 bg-surface border border-surface-highest rounded-sm shadow-xl p-1"
        >
          <button
            type="button"
            role="menuitem"
            data-testid="copy-resume"
            title={command}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm font-label text-[11px] uppercase tracking-widest text-on-surface-variant hover:bg-surface-highest hover:text-on-surface"
            onClick={(e) => {
              e.stopPropagation();
              copy();
            }}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            Copy resume command
          </button>
        </div>
      )}
    </div>
  );
}
