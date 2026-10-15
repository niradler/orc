import type { LiveSession } from "@/api/client";

export const STATUS: Record<LiveSession["status"], { label: string; dot: string }> = {
  running: { label: "working", dot: "bg-progress motion-safe:animate-pulse" },
  idle: { label: "waiting for you", dot: "bg-tertiary" },
  stopped: { label: "ended", dot: "bg-outline" },
  error: { label: "error", dot: "bg-error" },
};

export function resumeCommand(s: LiveSession): string | null {
  if (!s.session_id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(s.session_id)) return null;
  const cwd = s.cwd?.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, "");
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(cwd ?? "");
  const cd = cwd
    ? windows
      ? `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; `
      : `cd '${cwd.replace(/'/g, "'\\''")}' && `
    : "";
  if (s.agent === "claude") return `${cd}claude --resume ${s.session_id}`;
  if (s.agent === "codex") return `${cd}codex resume ${s.session_id}`;
  if (s.agent === "cursor-agent") return `${cd}agent --resume ${s.session_id}`;
  if (s.agent === "gemini") return `${cd}gemini --resume ${s.session_id}`;
  return null;
}

export function resumeUnavailableReason(session: LiveSession): string | null {
  if (resumeCommand(session)) return null;
  if (session.agent === "cursor")
    return "Cursor IDE conversations cannot resume in a CLI terminal.";
  if (!session.session_id) return "No native session ID was recorded.";
  return `Terminal resume is unavailable for this ${session.agent} session.`;
}

export function scopedSessionPath(path: string, project: string | null): string {
  if (!project) return path;
  const [pathname, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.set("project", project);
  return `${pathname}?${params}`;
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
