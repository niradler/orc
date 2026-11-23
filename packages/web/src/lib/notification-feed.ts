import type { HumanRequest } from "@orc/core/human-requests";
import type { OrcNotification } from "@orc/core/notifications";

/** The open workspace the notifier compares against without importing UI modules. */
export type NotificationView = {
  active: boolean;
  pathname: string;
  search: string;
  chatThreadId: string | null;
  /** Native session the open chat thread was resumed from, if any. */
  threadSourceId?: string | null;
  /** Side chat thread open alongside the workspace or Chat page, if any. */
  sideChatThreadId?: string | null;
  /** Native session the open side chat thread was resumed from, if any. */
  sideThreadSourceId?: string | null;
  sessions?: readonly {
    id: string;
    agent: string;
    host: string | null;
    session_id: string | null;
  }[];
  requests?: readonly Pick<HumanRequest, "id" | "input">[];
};

/** True when the notification's own destination is already on screen. */
export function notificationInView(item: OrcNotification, view: NotificationView): boolean {
  if (!view.active) return false;
  const params = new URLSearchParams(view.search);
  const target = new URL(item.path, "http://orc.invalid");
  const request =
    item.type === "human.request"
      ? view.requests?.find((request) => request.id === item.source_id)
      : undefined;
  const targetThread =
    target.searchParams.get("chatThread") ??
    target.searchParams.get("sideChatThread") ??
    request?.input.origin.chat_thread_id;
  const pageOpen = view.pathname === "/chat" || params.get("chat") === "full";
  const sideOpen = params.get("chat") === "open";
  const surfaceAware = "sideChatThreadId" in view || "sideThreadSourceId" in view;
  const openThreads = new Set<string>();
  const openSources = new Set<string>();
  if (pageOpen) {
    if (view.chatThreadId) openThreads.add(view.chatThreadId);
    if (view.threadSourceId) openSources.add(view.threadSourceId);
  }
  if (sideOpen) {
    const sideThread = surfaceAware ? view.sideChatThreadId : view.chatThreadId;
    const sideSource = surfaceAware ? view.sideThreadSourceId : view.threadSourceId;
    if (sideThread) openThreads.add(sideThread);
    if (sideSource) openSources.add(sideSource);
  }
  if (targetThread && openThreads.has(targetThread)) return true;
  if (item.type.startsWith("agent.") && openSources.has(item.source_id)) return true;
  const liveId = pageOpen ? (params.get("sessionLive") ?? params.get("sessionView")) : null;
  if (
    liveId &&
    target.pathname === "/chat" &&
    (target.searchParams.get("sessionLive") === liveId ||
      target.searchParams.get("sessionView") === liveId)
  )
    return true;
  const origin = request?.input.origin;
  if (!origin || !view.sessions?.length) return false;
  const candidateSessionIds = new Set<string>(openSources);
  if (liveId) candidateSessionIds.add(liveId);
  if (candidateSessionIds.size === 0) return false;
  return view.sessions.some(
    (session) =>
      candidateSessionIds.has(session.id) &&
      session.agent.replace(/-cli$/, "") === origin.backend.replace(/-cli$/, "") &&
      session.host === (origin.execution_host ?? null) &&
      session.session_id === (origin.native_session_id ?? origin.session_id),
  );
}

/** History and delivery share IDs; a reload establishes a baseline rather than replaying it. */
export class NotificationFeed {
  private baseline: number | null = null;
  private seen = new Map<string, number>();
  private pending = new Map<string, { due: number; item: OrcNotification }>();
  private current = new Map<string, OrcNotification>();

  update(items: readonly OrcNotification[], now: number): void {
    this.current = new Map(items.map((item) => [item.id, item]));
    for (const [id, expires] of this.seen) if (expires <= now) this.seen.delete(id);
    if (this.baseline === null) {
      this.baseline = Math.max(0, ...items.map((item) => item.created_at));
      for (const item of items) this.seen.set(item.id, item.expires_at);
      return;
    }
    for (const item of items) {
      if (this.seen.has(item.id)) continue;
      this.seen.set(item.id, item.expires_at);
      if (
        item.created_at < this.baseline ||
        item.read_at !== null ||
        item.dismissed_at !== null ||
        item.expires_at <= now
      )
        continue;
      this.pending.set(item.id, { due: now + 1000, item });
    }
  }

  flush(now: number, inView: (item: OrcNotification) => boolean): OrcNotification[] {
    const result: OrcNotification[] = [];
    for (const [id, pending] of this.pending) {
      if (now < pending.due) continue;
      this.pending.delete(id);
      const item = this.current.get(id);
      if (
        !item ||
        item.read_at !== null ||
        item.dismissed_at !== null ||
        item.expires_at <= now ||
        inView(item)
      )
        continue;
      if (pending.item.requires_action && !item.requires_action) continue;
      result.push(item);
    }
    return result;
  }
}
