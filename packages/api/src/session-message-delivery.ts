import { changes } from "@orc/core/changes";
import { createLogger } from "@orc/core/logger";
import { sessionMessageContext } from "@orc/core/session-messages";
import { ChatStore } from "@orc/db/chat";
import { getDb, getSqlite } from "@orc/db/client";
import { gateway_sessions } from "@orc/db/schema";
import { SessionMessageStore } from "@orc/db/session-messages";
import { eq } from "drizzle-orm";
import { getHandoffService } from "./handoffs/service.js";
import {
  defaultDeliveryBackend,
  deliverWhenIdle,
  type PushTarget,
  pushTargetForSession,
  sessionIdle,
} from "./human-request-delivery.js";
import { activeTurns, chatControl, runChatTurn, turnKey } from "./sessions/turns.js";

const logger = createLogger("session-message-delivery");

const SWEEP_MS = 5 * 60 * 1000;

type DeliveryDeps = {
  store: SessionMessageStore;
  target(sessionId: string): Promise<PushTarget | null>;
  idle(target: PushTarget): Promise<boolean>;
  resumed(target: PushTarget): Promise<void>;
  backend: ReturnType<typeof defaultDeliveryBackend>;
  chatTurn(target: PushTarget, prompt: string): Promise<void> | null;
};

function chatTarget(threadId: string): PushTarget | null {
  const thread = new ChatStore(getSqlite()).get(threadId);
  if (!thread) return null;
  return {
    sourceId: thread.id,
    agent: thread.config.agent,
    backend: thread.backend,
    runtimeId: thread.runtimeId ?? thread.id,
    host: thread.host,
    cwd: thread.cwd,
    model: thread.config.model ?? null,
    fingerprint: `chat:${crypto.randomUUID()}`,
    threadId: thread.id,
  };
}

function deliveryKey(target: PushTarget): string {
  return target.threadId && target.runtimeId === target.threadId
    ? target.threadId
    : turnKey(target.host, target.backend, target.runtimeId);
}

async function exitedTarget(sessionId: string): Promise<PushTarget | null> {
  const chat = chatTarget(sessionId);
  if (chat) return chat;
  const row = await getDb().query.gateway_sessions.findFirst({
    where: eq(gateway_sessions.id, sessionId),
  });
  // A live session owns its inbox: its next hook delivers. Only exited processes
  // are resumed here, so a running turn is never duplicated.
  if (row?.status !== "stopped") return null;
  return pushTargetForSession(sessionId);
}

function defaultDeps(): DeliveryDeps {
  return {
    store: new SessionMessageStore(getSqlite()),
    target: exitedTarget,
    idle: async (target) =>
      target.threadId
        ? !chatControl().running(target.threadId) && !chatControl().full()
        : sessionIdle(target),
    resumed: (target) => getHandoffService().markResumed(target.sourceId),
    backend: defaultDeliveryBackend(),
    chatTurn: (target, prompt) =>
      runChatTurn(target.threadId ? { threadId: target.threadId } : target, prompt) ??
      (target.threadId
        ? Promise.reject(new Error("The chat could not start a turn; retry when it is idle"))
        : null),
  };
}

export async function deliverIdleSessionMessages(
  deps: DeliveryDeps = defaultDeps(),
  busy = new Map<string, string>(),
): Promise<void> {
  const targets = new Map<string, PushTarget>();
  for (const sessionId of deps.store.pendingTargets()) {
    const target = await deps.target(sessionId).catch(() => null);
    if (!target) continue;
    targets.set(deliveryKey(target), target);
  }
  await Promise.all(
    [...targets]
      .filter(([key, target]) => !activeTurns.has(key) && busy.get(key) !== target.fingerprint)
      .map(([key, target]) => deliver(deps, key, target, busy)),
  );
}

function deliver(
  deps: DeliveryDeps,
  key: string,
  target: PushTarget,
  busy: Map<string, string>,
): Promise<void> {
  return deliverWhenIdle(deps, key, target, busy, {
    label: "session messages into an exited session",
    claim: () => deps.store.claimTarget(target.sourceId),
    prompt: sessionMessageContext,
    delivered: (claimed, via) =>
      deps.store.deliver(
        claimed.map((message) => message.id),
        via,
      ),
    failed: (claimed, message) =>
      deps.store.failed(
        claimed.map((entry) => entry.id),
        message,
      ),
    changed: () => changes.publish("session-messages"),
  });
}

export function startSessionMessageDelivery(): () => void {
  const deps = defaultDeps();
  const busy = new Map<string, string>();
  if (deps.store.interruptInFlight()) changes.publish("session-messages", "sessions");
  let check: ReturnType<typeof setTimeout> | undefined;
  let sweep: ReturnType<typeof setInterval> | undefined;
  const run = () => {
    chatControl().startPending();
    deliverIdleSessionMessages(deps, busy).catch((err) =>
      logger.error("Session message delivery failed", err),
    );
  };
  const schedule = () => {
    clearTimeout(check);
    check = setTimeout(run, 250);
  };
  const unsubscribe = changes.subscribe(({ resources }) => {
    if (resources.includes("session-messages") || resources.includes("sessions")) schedule();
  });
  sweep = setInterval(run, SWEEP_MS);
  sweep.unref();
  schedule();
  return () => {
    unsubscribe();
    clearTimeout(check);
    clearInterval(sweep);
  };
}
