import type { LiveSession } from "@/api/client";

export const STATUS: Record<LiveSession["status"], { label: string; dot: string }> = {
  running: { label: "working", dot: "bg-tertiary animate-pulse" },
  idle: { label: "waiting for you", dot: "bg-primary" },
  stopped: { label: "ended", dot: "bg-outline" },
  error: { label: "error", dot: "bg-error" },
};

export function resumeCommand(s: LiveSession): string | null {
  if (!s.session_id) return null;
  const cd = s.cwd ? `cd '${s.cwd.replace(/'/g, "'\\''")}' && ` : "";
  if (s.agent === "claude") return `${cd}claude --resume ${s.session_id}`;
  if (s.agent === "codex") return `${cd}codex resume ${s.session_id}`;
  return null;
}

export function formatTokenCount(n: number, estimated: boolean): string {
  const text =
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1000
        ? `${Math.round(n / 1000)}k`
        : `${n}`;
  return estimated ? `~${text}` : text;
}

export function formatTokens(s: LiveSession): string {
  return s.tokens_used == null ? "\u2014" : formatTokenCount(s.tokens_used, s.tokens_estimated);
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
