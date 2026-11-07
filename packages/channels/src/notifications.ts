import { createHash, randomUUID } from "node:crypto";
import {
  NotificationFilterSchema,
  notificationMatches,
  notificationSummary,
} from "@orc/core/notifications";
import {
  NotificationDeliveryStore,
  notificationDestination,
} from "@orc/db/notification-deliveries";
import type { ChannelService } from "./service.js";

const active = new WeakSet<ChannelService>();

export async function forwardChannelNotifications(
  service: ChannelService,
  store = new NotificationDeliveryStore(service.store.db),
  stopping: () => boolean = () => false,
): Promise<void> {
  if (active.has(service)) return;
  active.add(service);
  try {
    store.enqueue(service.connections());
    if (!store.policy().enabled) return;
    const owner = randomUUID();
    for (let count = 0; count < 20; count++) {
      if (stopping()) break;
      const claim = store.claim(owner);
      if (!claim) break;
      const event = store.event(claim.notification_id);
      const policy = store.policy();
      const connection = service.connections().find((value) => value.id === claim.connection_id);
      const target = connection?.targets.find((value) => value.id === claim.target_id);
      if (
        !event ||
        !policy.enabled ||
        !connection?.enabled ||
        !target?.outbound ||
        !notificationMatches(
          event,
          target.notifications ?? NotificationFilterSchema.parse({}),
          target.project_ids,
        ) ||
        claim.destination !== notificationDestination(connection, target) ||
        event.created_at < store.startsAt(connection.id, target.id)
      ) {
        store.finish(claim, "skipped", "Expired, paused, filtered or destination changed");
        continue;
      }
      // Producers retain their explicit provider selection; delivery grants no response authority.
      if (event.type === "human.request") {
        const request = service.store.db
          .query<{ payload: string }, [string]>("SELECT payload FROM human_requests WHERE id=?")
          .get(event.source_id);
        const notify: unknown = request ? JSON.parse(request.payload).notify : [];
        if (!Array.isArray(notify) || !notify.includes(connection.provider)) {
          store.finish(claim, "skipped", "Producer did not select this provider");
          continue;
        }
      }
      const path =
        event.type === "human.request"
          ? `/notifications?request=${encodeURIComponent(event.source_id)}`
          : event.type.startsWith("job.") || event.type.startsWith("agent.")
            ? event.path
            : "/notifications";
      const link = new URL(path, policy.base_url);
      if (link.origin !== new URL(policy.base_url).origin) {
        store.finish(claim, "failed", "Unsafe source link");
        continue;
      }
      const key = createHash("sha256")
        .update(JSON.stringify([event.id, connection.id, target.id]))
        .digest("hex");
      try {
        const receipt = await service.send({
          connection: connection.id,
          target: target.id,
          project_id: event.project_id,
          idempotency_key: `notification:${key}:${claim.attempts}`,
          message: {
            text: notificationSummary(event),
            format: "plain",
            links: [{ label: "Open in ORC", url: link.href }],
          },
        });
        if (receipt.status === "accepted") store.finish(claim, "delivered", null, receipt.id);
        else if (
          receipt.status === "failed" &&
          receipt.error === "Channel provider: rate_limited" &&
          claim.attempts < 4
        )
          store.finish(claim, "pending", "Rate limited; retry scheduled", receipt.id);
        else
          store.finish(
            claim,
            receipt.status === "failed" ? "failed" : "unknown",
            receipt.status === "failed"
              ? "Provider rejected delivery"
              : "Delivery uncertain; inspect provider before retrying",
            receipt.id,
          );
      } catch {
        store.finish(claim, "failed", "Destination unavailable; check channel settings");
      }
    }
  } finally {
    active.delete(service);
  }
}
