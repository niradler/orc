import { changes } from "@orc/core/changes";
import type { ChatThread } from "@orc/core/chat";
import { ForbiddenError } from "@orc/core/errors";
import { execHostFor, hostRuntime } from "@orc/core/exec-host";
import { createLogger } from "@orc/core/logger";
import {
  SESSION_MESSAGE_MAX_BODY,
  type SessionLineage,
  type SessionMessageCreate,
  type SessionMessageResult,
  type SessionMessageSender,
  type SessionSubagents,
  sessionMessageBackend,
  sessionMessageContext,
  sessionMessageHookSupported,
} from "@orc/core/session-messages";
import { ChatStore } from "@orc/db/chat";
import { getSqlite } from "@orc/db/client";
import { SessionMessageStore } from "@orc/db/session-messages";
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
): Promise<SessionMessageResult> {
  const mails = new SessionMessageStore(getSqlite());
  const target = mails.target(input.session_id, input.backend);
  const chat = target.status === "chat";
  const mode = input.mode ?? "queue";
  if (mode !== "queue") requireAncestor(sender, target.id);
  const message = mails.create(input, sender);
  let delivery: SessionMessageResult["target"]["delivery"] = chat
    ? "chat"
    : target.status === "stopped"
      ? "resume"
      : sessionMessageHookSupported(target.backend)
        ? "hook"
        : "unsupported";
  if (chat && mode === "steer" && message.state === "queued" && mails.take(message.id)) {
    try {
      if (await chatControl().steer({ threadId: target.id }, sessionMessageContext([message]))) {
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
  };
}

export function lastReply(thread: ChatThread): string {
  return (
    [...thread.messages].reverse().find((message) => message.role === "assistant")?.content ?? ""
  );
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
  const body = [
    head,
    reply
      ? `Last reply:\n${reply.length > room ? `${reply.slice(0, room)}\n[truncated]` : reply}`
      : "",
    tail,
  ]
    .filter(Boolean)
    .join("\n\n");
  sendToSession(
    {
      session_id: spawn.sessionId,
      body,
      mode: "steer",
      request_id: `child:${thread.id}:${eventId}`.slice(0, 128),
    },
    {
      kind: "system",
      session_id: thread.id,
      native_id: thread.runtimeId,
      backend: sessionMessageBackend(thread.backend),
      label: `child session ${thread.title}`.slice(0, 200),
    },
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
    .query<SubagentRow, [string, string | null, string | null, string | null]>(
      `SELECT ${LINEAGE_COLUMNS}, transcript_path, created_at FROM gateway_sessions
       WHERE (id = ?1 OR id = ?4 OR runtime_session_id = ?1 OR (runtime_session_id = ?2 AND backend = ?3))
       AND parent_session_id IS NULL ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(id, thread?.runtimeId ?? null, thread?.backend ?? null, thread?.sourceId ?? null);
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
