import type { OrcNotification } from "@orc/core/notifications";

export type NotificationToastEntry = { id: string; items: OrcNotification[] };

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
