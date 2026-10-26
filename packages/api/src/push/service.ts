import type { HumanRequest } from "@orc/core/human-requests";
import { createLogger } from "@orc/core/logger";
import type { PushMessage, PushTopic } from "@orc/core/push";
import { getSqlite } from "@orc/db/client";
import { currentHumanRequest, HumanRequestStore } from "@orc/db/human-requests";
import { PushStore, type PushTarget } from "@orc/db/push";
import webpush from "web-push";

const logger = createLogger("push");
// Apple rejects VAPID subjects on localhost; the project URL is a stable public contact.
const VAPID_SUBJECT = process.env.ORC_PUSH_SUBJECT ?? "https://github.com/niradler/orc";
const TIME_TO_LIVE_SECONDS = 60 * 60;
const SEND_TIMEOUT_MS = 10_000;
const ATTENTION_SCAN_MS = 5_000;
const ATTENTION_CHANNEL = "webpush";

export type PushDeps = {
  store: PushStore;
  fetch: typeof fetch;
};

export type DeliveryResult = { sent: number; failed: number; expired: number };

function defaultDeps(): PushDeps {
  return { store: new PushStore(getSqlite()), fetch };
}

export function vapidPublicKey(deps: PushDeps = defaultDeps()): string {
  return deps.store.vapidKeys(() => webpush.generateVAPIDKeys()).publicKey;
}

async function deliver(deps: PushDeps, target: PushTarget, message: PushMessage) {
  const keys = deps.store.vapidKeys(() => webpush.generateVAPIDKeys());
  const request = webpush.generateRequestDetails(
    { endpoint: target.endpoint, keys: target.keys },
    JSON.stringify(message),
    {
      vapidDetails: {
        subject: VAPID_SUBJECT,
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
      },
      TTL: TIME_TO_LIVE_SECONDS,
      urgency: "high",
      contentEncoding: "aes128gcm",
    },
  );
  return deps.fetch(request.endpoint, {
    method: request.method,
    headers: request.headers as Record<string, string>,
    body: request.body,
    redirect: "error",
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
}

/** Sends to every device subscribed to `topic`, or only `deviceId` when given. */
export async function sendPush(
  topic: PushTopic | null,
  message: PushMessage,
  deviceId?: string,
  deps: PushDeps = defaultDeps(),
): Promise<DeliveryResult> {
  const result: DeliveryResult = { sent: 0, failed: 0, expired: 0 };
  const targets = deps.store.targets(topic, deviceId);
  await Promise.all(
    targets.map(async (target) => {
      try {
        const response = await deliver(deps, target, message);
        if (response.ok) {
          deps.store.markDelivered(target.id);
          result.sent++;
        } else if (response.status === 404 || response.status === 410) {
          deps.store.expire(target.id);
          result.expired++;
        } else {
          deps.store.markFailed(target.id);
          result.failed++;
          logger.warn(`Push delivery rejected (${response.status}) for device ${target.id}`);
        }
      } catch (err) {
        deps.store.markFailed(target.id);
        result.failed++;
        logger.warn(`Push delivery failed for device ${target.id}`, err);
      }
    }),
  );
  return result;
}

/** Fire-and-forget delivery for event hooks; errors are logged, never thrown into the caller. */
export function notify(topic: PushTopic, message: PushMessage): void {
  sendPush(topic, message).catch((err) => logger.error("Push notification failed", err));
}

export function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

export function attentionMessage(request: HumanRequest): PushMessage {
  const verb = request.input.kind === "approval" ? "Approval needed" : "Question";
  return {
    title: `${verb} · ${request.input.origin.backend}`,
    body: truncate(request.input.prompt, 180),
    url: "/attention",
    tag: `attention:${request.id}`,
  };
}

/** Pushes each pending human request once per device; the durable lease dedupes across restarts. */
export async function notifyPendingAttention(
  humanRequests: HumanRequestStore,
  deps: PushDeps,
): Promise<void> {
  const targets = deps.store.targets("attention");
  if (!targets.length) return;
  for (const entry of humanRequests.list()) {
    const request = currentHumanRequest(humanRequests, entry.id);
    if (request.status !== "pending") continue;
    for (const target of targets) {
      if (!humanRequests.reserveNotification(request, ATTENTION_CHANNEL, target.id, false))
        continue;
      const result = await sendPush(null, attentionMessage(request), target.id, deps);
      // Expired devices are gone, so mark them done too; transient failures retry after the lease.
      if (result.sent || result.expired)
        humanRequests.notificationSent(request.id, ATTENTION_CHANNEL, target.id);
    }
  }
}

export function startAttentionPush(): () => void {
  const deps = defaultDeps();
  const humanRequests = new HumanRequestStore(getSqlite());
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    notifyPendingAttention(humanRequests, deps)
      .catch((err) => logger.error("Attention push scan failed", err))
      .finally(() => {
        busy = false;
      });
  }, ATTENTION_SCAN_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
