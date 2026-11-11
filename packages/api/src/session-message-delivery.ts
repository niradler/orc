import { changes } from "@orc/core/changes";
import { createLogger } from "@orc/core/logger";
import { sessionMessageContext } from "@orc/core/session-messages";
import { getDb, getSqlite } from "@orc/db/client";
import { gateway_sessions } from "@orc/db/schema";
import { SessionMessageStore } from "@orc/db/session-messages";
import { eq } from "drizzle-orm";
import { getHandoffService } from "./handoffs/service.js";
import {
  defaultDeliveryBackend,
  type PushTarget,
  pushTargetForSession,
  runTurn,
  sessionIdle,
} from "./human-request-delivery.js";
import { activeTurns, runChatTurn, turnKey } from "./sessions/turns.js";

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

async function exitedTarget(sessionId: string): Promise<PushTarget | null> {
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
    idle: sessionIdle,
    resumed: (target) => getHandoffService().markResumed(target.sourceId),
    backend: defaultDeliveryBackend(),
    chatTurn: (target, prompt) => runChatTurn(target, prompt),
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
    const key = turnKey(target.host, target.backend, target.runtimeId);
    targets.set(key, target);
  }
  await Promise.all(
    [...targets]
      .filter(([key, target]) => !activeTurns.has(key) && busy.get(key) !== target.fingerprint)
      .map(([key, target]) => deliver(deps, key, target, busy)),
  );
}

async function deliver(
  deps: DeliveryDeps,
  key: string,
  target: PushTarget,
  busy: Map<string, string>,
): Promise<void> {
  if (activeTurns.has(key)) return;
  activeTurns.add(key);
  let claimed: ReturnType<SessionMessageStore["claim"]> = [];
  try {
    if (!(await deps.idle(target).catch(() => false))) {
      busy.set(key, target.fingerprint);
      return;
    }
    busy.delete(key);
    claimed = deps.store.claimTarget(target.sourceId);
    if (!claimed.length) return;
    changes.publish("session-messages");
    const prompt = sessionMessageContext(claimed);
    const inChat = deps.chatTurn(target, prompt);
    if (inChat) await inChat;
    else {
      await runTurn(deps, target, prompt);
      await deps.resumed(target);
    }
    deps.store.deliver(
      claimed.map((message) => message.id),
      inChat ? "chat" : "resume",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Could not deliver session message into an exited session", {
      session: target.sourceId,
      error: message,
    });
    deps.store.failed(
      claimed.map((entry) => entry.id),
      message,
    );
  } finally {
    activeTurns.delete(key);
    if (claimed.length) changes.publish("session-messages");
  }
}

export function startSessionMessageDelivery(): () => void {
  const deps = defaultDeps();
  const busy = new Map<string, string>();
  if (deps.store.interruptInFlight()) changes.publish("session-messages", "sessions");
  let check: ReturnType<typeof setTimeout> | undefined;
  let sweep: ReturnType<typeof setInterval> | undefined;
  const run = () => {
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
