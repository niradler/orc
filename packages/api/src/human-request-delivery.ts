import { type AgentBackend, type AgentEvent, createBackend } from "@orc/agent-runtime";
import { changes } from "@orc/core/changes";
import { nativeChatAgent } from "@orc/core/chat";
import { chatRuntimeFor } from "@orc/core/coding-agents";
import { loadConfig } from "@orc/core/config";
import { execHostFor, hostRuntime } from "@orc/core/exec-host";
import type { HumanRequest } from "@orc/core/human-requests";
import { createLogger } from "@orc/core/logger";
import { getDb, getSqlite } from "@orc/db/client";
import { HumanRequestStore } from "@orc/db/human-requests";
import { gateway_sessions } from "@orc/db/schema";
import { and, eq, inArray, or } from "drizzle-orm";
import { getHandoffService } from "./handoffs/service.js";
import { LIVE_CHAT_ID } from "./session-watcher.js";
import { codexWriterOwned } from "./sessions/ownership.js";
import {
  activeTurns,
  type ChatTarget,
  chatControl,
  runChatTurn,
  turnKey,
} from "./sessions/turns.js";

const logger = createLogger("human-request-delivery");
export const PUSH_GRACE_MS = 15000;
const TURN_TIMEOUT_MS = 15 * 60000;

export type PushTarget = {
  sourceId: string;
  agent: string;
  backend: string;
  runtimeId: string;
  host: string | null;
  cwd: string;
  model: string | null;
  fingerprint: string;
  threadId?: string;
};

export type DeliveryDeps = {
  store: HumanRequestStore;
  target(request: HumanRequest): Promise<PushTarget | null>;
  idle(target: PushTarget): Promise<boolean>;
  resumed(target: PushTarget): Promise<void>;
  backend(name: string): AgentBackend;
  chatTurn(target: PushTarget, prompt: string): Promise<void> | null;
};

function nativeBackend(name: string): string {
  const value = name.toLowerCase().replace(/-cli$/, "");
  return value === "claude-code" ? "claude" : value;
}

async function findTarget(request: HumanRequest): Promise<PushTarget | null> {
  const origin = request.input.origin;
  const ids = [origin.session_id, origin.native_session_id].filter((id): id is string => !!id);
  const rows = (
    await getDb()
      .select()
      .from(gateway_sessions)
      .where(
        and(
          eq(gateway_sessions.chat_id, LIVE_CHAT_ID),
          or(inArray(gateway_sessions.id, ids), inArray(gateway_sessions.runtime_session_id, ids)),
        ),
      )
  ).filter(
    (row) =>
      nativeBackend(row.backend) === nativeBackend(origin.backend) &&
      (origin.execution_host === undefined ||
        (row.execution_host ?? null) === origin.execution_host),
  );
  const row = rows[0];
  const agent = row && nativeChatAgent(row.backend);
  if (
    rows.length !== 1 ||
    !row ||
    !agent ||
    !row.cwd ||
    !row.runtime_session_id ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(row.runtime_session_id)
  )
    return null;
  return {
    sourceId: row.id,
    agent,
    backend: chatRuntimeFor(agent),
    runtimeId: row.runtime_session_id,
    host: row.execution_host ?? null,
    cwd: row.cwd,
    model: row.model ?? null,
    fingerprint: `${row.status}:${row.pid ?? ""}:${row.updated_at?.getTime() ?? ""}`,
  };
}

export async function pushTargetForSession(sourceId: string): Promise<PushTarget | null> {
  const row = await getDb().query.gateway_sessions.findFirst({
    where: eq(gateway_sessions.id, sourceId),
  });
  const agent = row && nativeChatAgent(row.backend);
  if (
    !row ||
    !agent ||
    !row.cwd ||
    !row.runtime_session_id ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(row.runtime_session_id)
  )
    return null;
  return {
    sourceId: row.id,
    agent,
    backend: chatRuntimeFor(agent),
    runtimeId: row.runtime_session_id,
    host: row.execution_host ?? null,
    cwd: row.cwd,
    model: row.model ?? null,
    fingerprint: `${row.status}:${row.pid ?? ""}:${row.updated_at?.getTime() ?? ""}`,
  };
}

export async function sessionIdle(target: PushTarget): Promise<boolean> {
  await getHandoffService().verifyResume(target.sourceId);
  const runtime = hostRuntime(execHostFor(target.host));
  if (target.agent === "codex") {
    if (await codexWriterOwned(runtime, target.runtimeId)) return false;
  } else {
    const row = await getDb().query.gateway_sessions.findFirst({
      where: eq(gateway_sessions.id, target.sourceId),
    });
    if (
      row?.pid &&
      (row.status === "running" || row.status === "idle") &&
      (await runtime.processAlive(row.pid))
    )
      return false;
  }
  return runtime.isDirectory(target.cwd);
}

function mockBackend(): AgentBackend {
  let prompt = "";
  return {
    name: "mock",
    preflight: async () => ({ ok: true }),
    stop: async () => {},
    startSession: async () => {
      throw new Error("Mock delivery only resumes sessions");
    },
    resumeSession: async (runtimeSessionId) => ({
      id: runtimeSessionId,
      send: async (text) => {
        prompt = text;
      },
      respondPermission: () => {},
      alive: () => true,
      close: async () => {},
      async *events(): AsyncGenerator<AgentEvent> {
        yield { type: "text", data: `Received ${prompt.match(/\((\w+)\)/)?.[1] ?? "answer"}` };
        yield { type: "result", data: { runtimeSessionId } };
      },
    }),
  };
}

export function defaultDeliveryBackend(): (name: string) => AgentBackend {
  return process.env.ORC_E2E_CHAT_MOCK === "1" ? mockBackend : createBackend;
}

function defaultDeps(): DeliveryDeps {
  return {
    store: new HumanRequestStore(getSqlite()),
    target: findTarget,
    idle: sessionIdle,
    resumed: (target) => getHandoffService().markResumed(target.sourceId),
    backend: defaultDeliveryBackend(),
    chatTurn: (target, prompt) => runChatTurn(target, prompt),
  };
}

function fence(text: string): string {
  const ticks = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}\n${text.replace(/\n$/, "")}\n${ticks}`;
}

export function deliveryMessage(requests: HumanRequest[]): string {
  const parts = requests.map((request) => {
    const lines = [
      `### ${request.input.title ?? "Human request"} (${request.id})`,
      `Request: ${request.input.prompt}`,
    ];
    const response = request.response;
    if (response?.kind === "question") lines.push(`Answer: ${response.answer}`);
    else if (response?.kind === "approval")
      lines.push(response.approved ? "Approved." : "Denied. Do not perform the action.");
    else if (response?.kind === "command") {
      const spec = request.input.command;
      lines.push(
        `The human ran this command on ${spec?.host ?? "local"} in ${spec?.cwd ?? "the requested folder"}:`,
        fence(response.script ?? spec?.script ?? ""),
        `Exit code: ${response.exit_code}`,
      );
      if (response.stdout) lines.push("stdout:", fence(response.stdout));
      if (response.stderr) lines.push("stderr:", fence(response.stderr));
      if (response.truncated) lines.push("Output was truncated.");
    }
    return lines.join("\n");
  });
  return [
    "ORC is delivering the human response to your pending request. ORC marks it delivered; do not poll or acknowledge it. Continue the task with this result.",
    ...parts,
  ].join("\n\n");
}

export async function runTurn(
  deps: Pick<DeliveryDeps, "backend">,
  target: PushTarget,
  prompt: string,
): Promise<void> {
  const backend = deps.backend(target.backend);
  const check = await backend.preflight({ executionHost: target.host });
  if (!check.ok) throw new Error(check.error ?? "The agent is unavailable.");
  const session = await backend.resumeSession(target.runtimeId, {
    cwd: target.cwd,
    executionHost: target.host,
    interactive: false,
    model: target.model ?? undefined,
    orcMcp: true,
    orcMcpMode: loadConfig().mcp.default_mode,
    acpxAgent: target.agent,
    acpxNativeSessionId: target.backend === "acpx" ? target.runtimeId : undefined,
  });
  const timer = setTimeout(() => void session.close().catch(() => {}), TURN_TIMEOUT_MS);
  let failure = "The agent ended before completing the delivered turn.";
  let responded = false;
  try {
    await session.send(prompt);
    for await (const event of session.events()) {
      if (event.type === "error") failure = event.data;
      else if (event.type === "result") {
        if (event.data.runtimeSessionId && event.data.runtimeSessionId !== target.runtimeId)
          throw new Error("The agent resumed a different session.");
        return;
      } else responded = true;
    }
    if (!responded) throw new Error(failure);
  } finally {
    clearTimeout(timer);
    await session.close().catch(() => {});
  }
}

export async function deliverIdleAnswers(
  deps: DeliveryDeps = defaultDeps(),
  busy = new Map<string, string>(),
): Promise<void> {
  const groups = new Map<string, { target: PushTarget; requests: HumanRequest[] }>();
  const steered = new Map<string, { target: ChatTarget; requests: HumanRequest[] }>();
  for (const request of deps.store.pushCandidates(PUSH_GRACE_MS)) {
    const threadId = request.input.origin.chat_thread_id;
    if (threadId && chatControl().canSteer({ threadId })) {
      const group = steered.get(threadId) ?? { target: { threadId }, requests: [] };
      group.requests.push(request);
      steered.set(threadId, group);
      continue;
    }
    const target = await deps.target(request).catch(() => null);
    if (!target) continue;
    const key = turnKey(target.host, target.backend, target.runtimeId);
    const group = groups.get(key) ?? { target, requests: [] };
    group.requests.push(request);
    groups.set(key, group);
  }
  for (const [key, group] of groups)
    if (activeTurns.has(key) && chatControl().canSteer(group.target))
      steered.set(key, { target: group.target, requests: group.requests });
  await Promise.all(
    [...steered.values()].map(({ target, requests }) => steer(deps, target, requests)),
  );
  // A held session is rechecked only once the watcher records a change to it.
  await Promise.all(
    [...groups]
      .filter(([key, { target }]) => !activeTurns.has(key) && busy.get(key) !== target.fingerprint)
      .map(([key, { target, requests }]) => deliver(deps, key, target, requests, busy)),
  );
}

async function steer(
  deps: Pick<DeliveryDeps, "store">,
  target: ChatTarget,
  requests: HumanRequest[],
): Promise<void> {
  const claimed = deps.store.claimPush(requests.map((request) => request.id).reverse());
  if (!claimed.length) return;
  changes.publish("human-requests");
  try {
    if (await chatControl().steer(target, deliveryMessage(claimed)))
      for (const request of claimed) deps.store.pushed(request.id);
    else for (const request of claimed) deps.store.releasePush(request.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const request of claimed) deps.store.pushFailed(request.id, message);
  } finally {
    changes.publish("human-requests");
  }
}

export type DeliveryBatch<T> = {
  claim(): T[];
  prompt(items: T[]): string;
  delivered(items: T[], via: "chat" | "resume"): void;
  failed(items: T[], error: string): void;
  changed(): void;
  label: string;
};

export async function deliverWhenIdle<T>(
  deps: Pick<DeliveryDeps, "idle" | "resumed" | "backend" | "chatTurn">,
  key: string,
  target: PushTarget,
  busy: Map<string, string>,
  batch: DeliveryBatch<T>,
): Promise<void> {
  if (activeTurns.has(key)) return;
  activeTurns.add(key);
  let claimed: T[] = [];
  try {
    if (!(await deps.idle(target).catch(() => false))) {
      busy.set(key, target.fingerprint);
      return;
    }
    busy.delete(key);
    claimed = batch.claim();
    if (!claimed.length) return;
    batch.changed();
    const prompt = batch.prompt(claimed);
    const inChat = deps.chatTurn(target, prompt);
    if (inChat) await inChat;
    else {
      await runTurn(deps, target, prompt);
      await deps.resumed(target);
    }
    batch.delivered(claimed, inChat ? "chat" : "resume");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Could not deliver ${batch.label}`, { session: target.sourceId, error: message });
    batch.failed(claimed, message);
  } finally {
    activeTurns.delete(key);
    if (claimed.length) batch.changed();
  }
}

function deliver(
  deps: DeliveryDeps,
  key: string,
  target: PushTarget,
  requests: HumanRequest[],
  busy: Map<string, string>,
): Promise<void> {
  return deliverWhenIdle(deps, key, target, busy, {
    label: "human answers into an idle session",
    claim: () => deps.store.claimPush(requests.map((request) => request.id).reverse()),
    prompt: deliveryMessage,
    delivered: (claimed) => {
      for (const request of claimed) deps.store.pushed(request.id);
    },
    failed: (claimed, message) => {
      for (const request of claimed) deps.store.pushFailed(request.id, message);
    },
    changed: () => changes.publish("human-requests"),
  });
}

export async function queuedAnswers(
  key: string,
  deps: Pick<DeliveryDeps, "store" | "target"> = defaultDeps(),
): Promise<HumanRequest[]> {
  const queued: HumanRequest[] = [];
  for (const request of deps.store.pushCandidates(0)) {
    const target = await deps.target(request).catch(() => null);
    if (target && turnKey(target.host, target.backend, target.runtimeId) === key)
      queued.unshift(request);
  }
  return queued;
}

export function startHumanRequestDelivery(): () => void {
  const deps = defaultDeps();
  const busy = new Map<string, string>();
  if (deps.store.interruptedPushes()) changes.publish("human-requests");
  let check: ReturnType<typeof setTimeout> | undefined;
  let due: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    deliverIdleAnswers(deps, busy)
      .catch((err) => logger.error("Human request delivery failed", err))
      .finally(() => {
        clearTimeout(due);
        try {
          const next = deps.store.nextPushAt(PUSH_GRACE_MS);
          if (next !== null) due = setTimeout(schedule, Math.max(0, next - Date.now()) + 50);
        } catch (err) {
          logger.error("Human request delivery could not schedule its next check", err);
        }
      });
  };
  const schedule = () => {
    clearTimeout(check);
    check = setTimeout(run, 250);
  };
  const unsubscribe = changes.subscribe(({ resources }) => {
    if (resources.includes("human-requests") || resources.includes("sessions")) schedule();
  });
  schedule();
  return () => {
    unsubscribe();
    clearTimeout(check);
    clearTimeout(due);
  };
}
