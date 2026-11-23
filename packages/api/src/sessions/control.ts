import { changes } from "@orc/core/changes";
import type { ChatThread } from "@orc/core/chat";
import { ConflictError, ForbiddenError } from "@orc/core/errors";
import { execHostFor, hostRuntime } from "@orc/core/exec-host";
import { createLogger } from "@orc/core/logger";
import {
  childOutcomeSummary,
  SESSION_MESSAGE_MAX_BODY,
  type SessionDelivery,
  type SessionLineage,
  type SessionMessage,
  type SessionMessageCreate,
  type SessionMessageResult,
  type SessionMessageSender,
  type SessionSubagents,
  sessionDeliveryFromMessage,
  sessionMessageBackend,
  sessionMessageContext,
  sessionMessageHookSupported,
  sessionMessageReceipt,
} from "@orc/core/session-messages";
import { ChatStore } from "@orc/db/chat";
import { getSqlite } from "@orc/db/client";
import { SessionMessageStore } from "@orc/db/session-messages";
import { sessionWaitingForHuman } from "../session-watcher.js";
import { subagentToolCalls } from "./subagent-links.js";
import { chatControl } from "./turns.js";

const logger = createLogger("session-control");
const LINEAGE_DEPTH = 8;

export type ChildOutcome = "finished" | "failed" | "stopped" | "question" | "approval";

export function spawnChain(threadId: string): string[] {
  const chats = new ChatStore(getSqlite());
  const chain: string[] = [];
  let current = chats.get(threadId)?.spawnedBy?.sessionId;
  while (current && chain.length < LINEAGE_DEPTH && !chain.includes(current)) {
    chain.push(current);
    current = chats.get(current)?.spawnedBy?.sessionId;
  }
  return chain;
}

export function requireAncestor(sender: SessionMessageSender, targetId: string): void {
  if (sender.kind !== "session") return;
  if (!sender.session_id || !spawnChain(targetId).includes(sender.session_id))
    throw new ForbiddenError(
      "Only the session that started this session (or one of its ancestors) can steer, interrupt or stop it; queue a message instead",
    );
}

export async function sendToSession(
  input: SessionMessageCreate,
  sender: SessionMessageSender,
  structuredDelivery?: SessionDelivery | null,
): Promise<SessionMessageResult> {
  const mails = new SessionMessageStore(getSqlite());
  const target = mails.target(input.session_id, input.backend);
  const chat = target.status === "chat";
  const mode = input.mode ?? "queue";
  if (mode !== "queue") requireAncestor(sender, target.id);
  const message = mails.create(input, sender, structuredDelivery ?? null);
  let delivery: SessionMessageResult["target"]["delivery"] = chat
    ? "chat"
    : target.status === "stopped"
      ? "resume"
      : sessionMessageHookSupported(target.backend)
        ? "hook"
        : "unsupported";
  if (chat && mode === "steer" && message.state === "queued" && mails.take(message.id)) {
    try {
      if (
        await chatControl().steer({ threadId: target.id }, sessionMessageContext([message]), {
          deliveries: [sessionDeliveryFromMessage(message)],
        })
      ) {
        mails.deliver([message.id], "steer");
        delivery = "steer";
      } else mails.release(message.id);
    } catch (error) {
      mails.failed([message.id], error instanceof Error ? error.message : String(error));
    }
  }
  if (chat && mode === "interrupt") chatControl().stop(target.id);
  changes.publish("session-messages", "sessions");
  return {
    message: mails.get(message.id),
    target: {
      session_id: target.id,
      backend: sessionMessageBackend(target.backend),
      status: chat ? (chatControl().running(target.id) ? "running" : "idle") : target.status,
      delivery,
    },
    receipt: sessionMessageReceipt(delivery),
  };
}

export async function deliverSessionMessageNow(id: string): Promise<SessionMessage> {
  const mails = new SessionMessageStore(getSqlite());
  const message = mails.get(id);
  if (message.state !== "queued")
    throw new ConflictError("Only a queued message can be delivered now");
  const waiting = chatControl().waiting(message.target_session_id);
  if (waiting)
    throw new ConflictError(
      "Answer the pending prompt first. This message stays queued until then.",
    );
  if (!chatControl().canSteer({ threadId: message.target_session_id }))
    throw new ConflictError(
      "This response cannot be steered right now. The message stays queued for the next safe point.",
    );
  if (!mails.take(message.id)) throw new ConflictError("This message is already being delivered");
  try {
    const steered = await chatControl().steer(
      { threadId: message.target_session_id },
      sessionMessageContext([message]),
      { deliveries: [sessionDeliveryFromMessage(message)] },
    );
    if (!steered) {
      mails.release(message.id);
      throw new ConflictError(
        "This response cannot be steered right now. The message stays queued for the next safe point.",
      );
    }
    mails.deliver([message.id], "steer");
    changes.publish("session-messages", "sessions");
    return mails.get(message.id);
  } catch (error) {
    if (error instanceof ConflictError) {
      mails.release(message.id);
      changes.publish("session-messages", "sessions");
      throw error;
    }
    mails.failed([message.id], error instanceof Error ? error.message : String(error));
    changes.publish("session-messages", "sessions");
    throw error;
  }
}

export function lastReply(thread: ChatThread): string {
  return (
    [...thread.messages].reverse().find((message) => message.role === "assistant")?.content ?? ""
  );
}

export type ChildWorkCounts = { working: number; waiting: number };

export type ChildWorkParent = {
  id: string;
  nativeId?: string | null;
  backend?: string | null;
  host?: string | null;
};

const nativeBackend = (backend: string | null | undefined) =>
  backend === "codex-cli" ? "codex" : backend === "claude-cli" ? "claude" : backend;

/**
 * Active work under sessions: chats they spawned plus the native subagents their provider
 * started. A parent reads as working while any of these hold a turn, and as needing a
 * human when one is parked on a question or approval. Direct children only — a child
 * with its own running children is itself running, so the rollup stays honest without
 * walking the whole tree on every status read. Batched: two queries for any list size.
 */
export function childWorkCountsMany(parents: ChildWorkParent[]): Map<string, ChildWorkCounts> {
  const sqlite = getSqlite();
  const counts = new Map<string, ChildWorkCounts>(
    parents.map((parent) => [parent.id, { working: 0, waiting: 0 }]),
  );
  const add = (ownerId: string, waiting: boolean) => {
    const count = counts.get(ownerId);
    if (!count) return;
    if (waiting) count.waiting++;
    else count.working++;
  };

  // Chats spawned by any parent id (a spawn records the chat id or the native id).
  const ownersBySpawnId = new Map<string, string[]>();
  for (const parent of parents) {
    for (const key of [parent.id, parent.nativeId]) {
      if (!key) continue;
      const owners = ownersBySpawnId.get(key) ?? [];
      owners.push(parent.id);
      ownersBySpawnId.set(key, owners);
    }
  }
  const spawnIds = [...ownersBySpawnId.keys()];
  if (spawnIds.length) {
    // Raw summaries, not parsed threads: a legacy or corrupt child row must not
    // take down the status read that lists it.
    const marks = spawnIds.map(() => "?").join(",");
    const children = sqlite
      .query<{ id: string; spawnedFrom: string | null; hasPrompt: number }, string[]>(
        `SELECT id, json_extract(data, '$.spawnedBy.sessionId') AS spawnedFrom,
           json_extract(data, '$.spawnedBy.prompt') IS NOT NULL AS hasPrompt
         FROM chat_threads WHERE json_valid(data)
           AND json_extract(data, '$.spawnedBy.sessionId') IN (${marks})
         ORDER BY updated_at DESC LIMIT 200`,
      )
      .all(...spawnIds);
    for (const child of children) {
      const running = chatControl().running(child.id);
      // A queued spawn holds work the parent is waiting on even before its first turn.
      if (!running && !child.hasPrompt) continue;
      const waiting = running && chatControl().waiting(child.id) !== null;
      for (const owner of ownersBySpawnId.get(child.spawnedFrom ?? "") ?? []) {
        add(owner, waiting);
      }
    }
  }

  // Native subagents the provider started under each parent's native session.
  const nativeParents = parents.filter((parent) => parent.nativeId && parent.backend);
  if (nativeParents.length) {
    const ownerByKey = new Map(
      nativeParents.map((parent) => [
        `${nativeBackend(parent.backend)}\u0000${parent.nativeId}\u0000${parent.host ?? ""}`,
        parent.id,
      ]),
    );
    const nativeIds = [...new Set(nativeParents.map((parent) => parent.nativeId as string))];
    const marks = nativeIds.map(() => "?").join(",");
    const children = sqlite
      .query<
        {
          backend: string;
          parent_session_id: string;
          host: string;
          runtime_session_id: string | null;
        },
        string[]
      >(
        `SELECT backend, parent_session_id, coalesce(execution_host, '') AS host, runtime_session_id
         FROM gateway_sessions WHERE status = 'running' AND parent_session_id IN (${marks})`,
      )
      .all(...nativeIds);
    for (const child of children) {
      const owner = ownerByKey.get(
        `${child.backend}\u0000${child.parent_session_id}\u0000${child.host}`,
      );
      if (!owner) continue;
      const waiting =
        !!child.runtime_session_id &&
        sessionWaitingForHuman(child.backend, child.host || null, child.runtime_session_id);
      add(owner, waiting);
    }
  }
  return counts;
}

export function childWorkCounts(id: string): ChildWorkCounts {
  const sqlite = getSqlite();
  const thread = threadWorkFields(sqlite, id);
  const lookup = sqlite.query<
    { backend: string; runtime_session_id: string | null; execution_host: string | null },
    [string]
  >(
    "SELECT backend, runtime_session_id, execution_host FROM gateway_sessions WHERE id = ?1 OR runtime_session_id = ?1 ORDER BY updated_at DESC LIMIT 1",
  );
  // A running chat may not have its runtime id yet; the discovered source links it.
  const native = lookup.get(id) ?? (thread?.sourceId ? lookup.get(thread.sourceId) : undefined);
  return (
    childWorkCountsMany([
      {
        id,
        nativeId: thread?.runtimeId ?? native?.runtime_session_id ?? null,
        backend: thread?.backend ?? native?.backend ?? null,
        host: thread?.host ?? native?.execution_host ?? null,
      },
    ]).get(id) ?? { working: 0, waiting: 0 }
  );
}

/**
 * The thread fields the rollup needs, read without the strict thread parse: the
 * chat list must keep answering for legacy, minimal or corrupt rows.
 */
function threadWorkFields(
  sqlite: ReturnType<typeof getSqlite>,
  id: string,
): {
  runtimeId: string | null;
  backend: string | null;
  host: string | null;
  sourceId: string | null;
} | null {
  const row = sqlite
    .query<{ data: string }, [string]>("SELECT data FROM chat_threads WHERE id = ?")
    .get(id);
  if (!row) return null;
  let data: unknown;
  try {
    data = JSON.parse(row.data);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : null);
  return {
    runtimeId: text("runtimeId"),
    backend: text("backend"),
    host: text("host"),
    sourceId: text("sourceId"),
  };
}

function outcomeText(outcome: ChildOutcome): string {
  if (outcome === "question" || outcome === "approval")
    return `is waiting for a human ${outcome}; you cannot answer it, a human must`;
  return outcome;
}

export function notifySpawner(thread: ChatThread, eventId: string, outcome: ChildOutcome): void {
  const spawn = thread.spawnedBy;
  if (!spawn?.notify) return;
  const head = `[orc child-session id=${thread.id} outcome=${outcome}]\nChild session "${thread.title}" ${outcomeText(outcome)}.`;
  const tail = `Read more with session_status {"session_id":"${thread.id}"}; reply with session_send.`;
  const room = SESSION_MESSAGE_MAX_BODY - head.length - tail.length - 40;
  const reply = outcome === "question" || outcome === "approval" ? "" : lastReply(thread);
  const trimmedReply = reply
    ? reply.length > room
      ? `${reply.slice(0, room)}\n[truncated]`
      : reply
    : "";
  const body = [head, trimmedReply ? `Last reply:\n${trimmedReply}` : "", tail]
    .filter(Boolean)
    .join("\n\n");
  const normalizedOutcome = outcome === "question" || outcome === "approval" ? "waiting" : outcome;
  const waitingFor = outcome === "question" || outcome === "approval" ? outcome : undefined;
  const structuredDelivery: SessionDelivery = {
    kind: "child_outcome",
    session_id: thread.id,
    title: thread.title.slice(0, 200),
    outcome: normalizedOutcome,
    ...(waitingFor ? { waiting_for: waitingFor } : {}),
    summary: childOutcomeSummary(normalizedOutcome, reply, waitingFor),
    body: trimmedReply || body,
  };
  sendToSession(
    {
      session_id: spawn.sessionId,
      body,
      mode: "queue",
      request_id: `child:${thread.id}:${eventId}`.slice(0, 128),
    },
    {
      kind: "system",
      session_id: thread.id,
      native_id: thread.runtimeId,
      backend: sessionMessageBackend(thread.backend),
      label: `child session ${thread.title}`.slice(0, 200),
    },
    structuredDelivery,
  ).catch((error) =>
    logger.warn("Could not notify the parent session", {
      child: thread.id,
      parent: spawn.sessionId,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

type LineageRow = {
  id: string;
  title: string | null;
  status: string;
  task_id: string | null;
  runtime_session_id: string | null;
  backend: string;
  execution_host: string | null;
  parent_session_id?: string | null;
  spawned_from_session_id?: string | null;
};

const LINEAGE_COLUMNS =
  "id, coalesce(display_title, title) AS title, status, task_id, runtime_session_id, backend, execution_host, parent_session_id, spawned_from_session_id";

function chatNode(thread: ChatThread): SessionLineage["children"][number] {
  const last = [...thread.messages].reverse().find((message) => message.role === "assistant");
  return {
    id: thread.id,
    title: thread.title,
    kind: "chat",
    status: chatControl().running(thread.id) ? "running" : (last?.turn?.outcome ?? "idle"),
    task_id: null,
  };
}

function sessionNode(row: LineageRow): SessionLineage["children"][number] {
  return {
    id: row.id,
    title: row.title ?? row.id,
    kind: "session",
    status: row.status,
    task_id: row.task_id,
  };
}

export function sessionLineage(id: string): SessionLineage {
  const sqlite = getSqlite();
  const chats = new ChatStore(sqlite);
  const own = chats.get(id);
  const row = sqlite
    .query<LineageRow, [string, string | null, string | null, string | null]>(
      `SELECT ${LINEAGE_COLUMNS} FROM gateway_sessions
       WHERE id = ?1 OR runtime_session_id = ?1 OR id = ?2 OR (runtime_session_id = ?3 AND backend = ?4)
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(id, own?.sourceId ?? null, own?.runtimeId ?? null, own?.backend ?? null);
  const threads = own
    ? [own]
    : row?.runtime_session_id
      ? chats.byRuntime(row.backend, row.execution_host, row.runtime_session_id)
      : [];
  const ids = [
    ...new Set(
      [id, row?.id, row?.runtime_session_id, ...threads.map((thread) => thread.id)].filter(
        (value): value is string => !!value,
      ),
    ),
  ];
  const marks = ids.map(() => "?").join(",");
  const delegated = sqlite
    .query<LineageRow, string[]>(
      `SELECT g.id, g.title, g.status, g.task_id, g.runtime_session_id, g.backend, g.execution_host
       FROM gateway_sessions g JOIN tasks t ON t.id = g.task_id
       WHERE t.origin_session_id IN (${marks}) ORDER BY g.created_at DESC LIMIT 200`,
    )
    .all(...ids);
  const parentId =
    threads.find((thread) => thread.spawnedBy)?.spawnedBy?.sessionId ??
    (row?.task_id
      ? sqlite
          .query<{ origin_session_id: string | null }, [string]>(
            "SELECT origin_session_id FROM tasks WHERE id = ?",
          )
          .get(row.task_id)?.origin_session_id
      : null) ??
    row?.parent_session_id ??
    row?.spawned_from_session_id;
  const parentChat = parentId ? chats.get(parentId) : null;
  const parentRow =
    parentId && !parentChat
      ? sqlite
          .query<LineageRow, [string, string | null]>(
            `SELECT ${LINEAGE_COLUMNS} FROM gateway_sessions WHERE (id = ?1 OR runtime_session_id = ?1) AND (?2 IS NULL OR backend = ?2) ORDER BY updated_at DESC LIMIT 1`,
          )
          .get(parentId, row?.backend ?? null)
      : null;
  return {
    parent: parentChat ? chatNode(parentChat) : parentRow ? sessionNode(parentRow) : null,
    children: [...chats.children(ids).map(chatNode), ...delegated.map(sessionNode)],
  };
}

type SubagentRow = LineageRow & { transcript_path: string | null; created_at: number };

export async function sessionSubagents(id: string): Promise<SessionSubagents> {
  const sqlite = getSqlite();
  const thread = new ChatStore(sqlite).get(id);
  const parent = sqlite
    .query<SubagentRow, [string, string | null, string | null]>(
      `SELECT ${LINEAGE_COLUMNS}, transcript_path, created_at FROM gateway_sessions
       WHERE (id = ?1 OR runtime_session_id = ?1 OR (runtime_session_id = ?2 AND backend = ?3))
       AND parent_session_id IS NULL ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(
      id,
      thread?.runtimeId ?? null,
      thread?.backend === "codex-cli"
        ? "codex"
        : thread?.backend === "claude-cli"
          ? "claude"
          : (thread?.backend ?? null),
    );
  if (!parent?.runtime_session_id) return { subagents: [] };
  const children = sqlite
    .query<SubagentRow, [string, string, string]>(
      `WITH RECURSIVE tree(id, runtime_session_id) AS (
         SELECT id, runtime_session_id FROM gateway_sessions
         WHERE backend = ?1 AND parent_session_id = ?2 AND coalesce(execution_host, '') = ?3
         UNION
         SELECT g.id, g.runtime_session_id FROM gateway_sessions g JOIN tree t
         ON g.parent_session_id = t.runtime_session_id
         WHERE g.backend = ?1 AND coalesce(g.execution_host, '') = ?3
       )
       SELECT ${LINEAGE_COLUMNS}, transcript_path, created_at FROM gateway_sessions
       WHERE id IN (SELECT id FROM tree) ORDER BY created_at, id LIMIT 500`,
    )
    .all(parent.backend, parent.runtime_session_id, parent.execution_host ?? "");
  const byNative = new Map(children.map((child) => [child.runtime_session_id, child.id]));
  const calls = await subagentToolCalls(
    hostRuntime(execHostFor(parent.execution_host)),
    parent,
    children,
  );
  return {
    subagents: children.map((child) => ({
      id: child.id,
      parent_id: byNative.get(child.parent_session_id ?? null) ?? null,
      session_id: child.runtime_session_id,
      title: child.title ?? "Subagent",
      status: child.status,
      tool_call_id: (child.runtime_session_id && calls.get(child.runtime_session_id)) || null,
      created_at: child.created_at,
    })),
  };
}
