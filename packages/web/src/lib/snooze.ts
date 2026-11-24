import type { HumanRequest } from "@orc/core/human-requests";

export const SNOOZE_PRESETS = [
  { id: "15m", label: "15 minutes", shortLabel: "15m", afterSeconds: 15 * 60 },
  { id: "1h", label: "1 hour", shortLabel: "1h", afterSeconds: 60 * 60 },
  { id: "3h", label: "3 hours", shortLabel: "3h", afterSeconds: 3 * 60 * 60 },
] as const;

export function tomorrowAtNine(now: Date = new Date()): number {
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0);
  return target.getTime();
}

export function isRequestSnoozed(
  request: Pick<HumanRequest, "status" | "snooze_until"> | null | undefined,
  now: number = Date.now(),
): boolean {
  return (
    !!request &&
    request.status === "pending" &&
    request.snooze_until !== null &&
    request.snooze_until > now
  );
}

export function formatSnoozeUntil(until: number, now: number = Date.now()): string {
  const date = new Date(until);
  const current = new Date(now);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sameDay =
    date.getFullYear() === current.getFullYear() &&
    date.getMonth() === current.getMonth() &&
    date.getDate() === current.getDate();
  if (sameDay) return time;
  const tomorrow = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1);
  const isTomorrow =
    date.getFullYear() === tomorrow.getFullYear() &&
    date.getMonth() === tomorrow.getMonth() &&
    date.getDate() === tomorrow.getDate();
  if (isTomorrow) return `Tomorrow ${time}`;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function toDatetimeLocalValue(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseDatetimeLocalValue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed).getTime();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeBackend(name: string | null | undefined): string {
  const lower = (name ?? "").toLowerCase().replace(/-cli$/, "");
  return lower === "claude-code" ? "claude" : lower;
}

export type SessionRequestTarget = {
  threadId?: string | null;
  sourceId?: string | null;
  runtimeId?: string | null;
  backend?: string | null;
  host?: string | null;
};

export function pendingRequestsForSession(
  requests: readonly HumanRequest[] | undefined,
  target: SessionRequestTarget,
): HumanRequest[] {
  if (!requests?.length) return [];
  const targetBackend = target.backend ? normalizeBackend(target.backend) : null;
  const targetIds = new Set(
    [target.sourceId, target.runtimeId].filter((value): value is string => Boolean(value)),
  );
  return requests.filter((request) => {
    if (request.status !== "pending") return false;
    const origin = request.input.origin;
    if (target.threadId && origin.chat_thread_id === target.threadId) return true;
    if (!targetIds.size) return false;
    if (targetBackend && normalizeBackend(origin.backend) !== targetBackend) return false;
    if (
      target.host !== undefined &&
      origin.execution_host !== undefined &&
      (origin.execution_host ?? null) !== (target.host ?? null)
    )
      return false;
    const originIds = [origin.session_id, origin.native_session_id].filter(
      (value): value is string => Boolean(value),
    );
    return originIds.some((id) => targetIds.has(id));
  });
}
