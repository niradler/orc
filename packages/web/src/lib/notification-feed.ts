import type { HumanRequest } from "@orc/core/human-requests";
import type { OrcNotification } from "@orc/core/notifications";

export type NotificationToastEntry = { id: string; items: OrcNotification[] };

/** The open workspace the notifier compares against without importing UI modules. */
export type NotificationView = {
  active: boolean;
  pathname: string;
  search: string;
  chatThreadId: string | null;
  /** Native session the open chat thread was resumed from, if any. */
  threadSourceId?: string | null;
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
    target.searchParams.get("chatThread") ?? request?.input.origin.chat_thread_id;
  const chatOpen = !!params.get("chat") || view.pathname === "/chat";
  if (chatOpen && targetThread && targetThread === view.chatThreadId) return true;
  // Resuming clears the link parameter, so the open thread remembers its source session.
  if (
    chatOpen &&
    view.threadSourceId &&
    item.type.startsWith("agent.") &&
    view.threadSourceId === item.source_id
  )
    return true;
  // A session notification is in view when the chat page shows that session's
  // conversation, its read-only view, or the same native session from a running terminal.
  if (view.pathname !== "/chat") return false;
  const liveId = params.get("sessionLive") ?? params.get("sessionView");
  if (
    liveId &&
    target.pathname === "/chat" &&
    (target.searchParams.get("sessionLive") === liveId ||
      target.searchParams.get("sessionView") === liveId)
  )
    return true;
  const session = view.sessions?.find((session) => session.id === (liveId ?? view.threadSourceId));
  const origin = request?.input.origin;
  return (
    !!session &&
    !!origin &&
    session.agent.replace(/-cli$/, "") === origin.backend.replace(/-cli$/, "") &&
    session.host === (origin.execution_host ?? null) &&
    session.session_id === (origin.native_session_id ?? origin.session_id)
  );
}

export function mergeNotificationToasts(
  current: readonly NotificationToastEntry[],
  incoming: readonly OrcNotification[],
): NotificationToastEntry[] {
  const needs = incoming
    .filter((item) => item.level === "needs-you")
    .map((item) => ({ id: item.id, items: [item] }));
  const previousNeeds = current.filter((entry) => entry.items[0]?.level === "needs-you");
  const completed = incoming.filter((item) => item.level === "done");
  const previousDone = current.filter((entry) => entry.items[0]?.level === "done");
  const done = [
    ...new Map(
      [...completed, ...previousDone.flatMap((entry) => entry.items)].map((item) => [
        item.id,
        item,
      ]),
    ).values(),
  ];
  const result = [...needs, ...previousNeeds];
  if (done.length)
    result.push({
      id: completed[0] ? `done:${completed[0].id}` : (previousDone[0]?.id ?? "done"),
      items: done,
    });
  return result.slice(0, 4);
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
