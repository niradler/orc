import type { ChatMessage, ChatThread } from "@orc/core/chat";
import { sessionMessageBackend } from "@orc/core/session-messages";
import { ChatStore } from "@orc/db/chat";
import { getDb, getSqlite } from "@orc/db/client";
import { gateway_sessions } from "@orc/db/schema";
import { eq } from "drizzle-orm";
import { LIVE_CHAT_ID } from "./common.js";

export type GatewaySessionRow = typeof gateway_sessions.$inferSelect;

export type ResolvedSession = {
  thread: ChatThread | null;
  gateway: GatewaySessionRow | null;
  canonicalId: string;
  chatId: string | null;
  liveId: string | null;
  nativeId: string | null;
  backend: string;
};

type GatewayLookupId = {
  id: string;
  chat_id: string;
  backend: string;
  execution_host: string | null;
  runtime_session_id: string | null;
  status: string;
  last_activity_at: number | null;
  updated_at: number;
};

function loadGatewayRow(id: string): GatewaySessionRow | null {
  return getDb().select().from(gateway_sessions).where(eq(gateway_sessions.id, id)).get() ?? null;
}

function backendMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return sessionMessageBackend(a) === sessionMessageBackend(b);
}

function pickBestGateway(
  rows: GatewayLookupId[],
  backend?: string,
  host?: string | null,
): GatewayLookupId | null {
  let candidates = rows;
  if (backend) {
    const filtered = candidates.filter((row) => backendMatches(row.backend, backend));
    if (filtered.length) candidates = filtered;
  }
  if (host !== undefined) {
    const hostFiltered = candidates.filter(
      (row) => (row.execution_host ?? null) === (host ?? null),
    );
    if (hostFiltered.length) candidates = hostFiltered;
  }
  candidates.sort((a, b) => {
    const liveA = a.chat_id === LIVE_CHAT_ID ? 0 : 1;
    const liveB = b.chat_id === LIVE_CHAT_ID ? 0 : 1;
    if (liveA !== liveB) return liveA - liveB;
    const stopA = a.status === "stopped" ? 1 : 0;
    const stopB = b.status === "stopped" ? 1 : 0;
    if (stopA !== stopB) return stopA - stopB;
    return (b.last_activity_at ?? b.updated_at) - (a.last_activity_at ?? a.updated_at);
  });
  return candidates[0] ?? null;
}

function findGatewayForThread(thread: ChatThread): GatewaySessionRow | null {
  const sqlite = getSqlite();
  if (thread.sourceId) {
    const bySource = loadGatewayRow(thread.sourceId);
    if (bySource) return bySource;
  }
  if (thread.runtimeId) {
    const rows = sqlite
      .query<GatewayLookupId, [string]>(
        `SELECT id, chat_id, backend, execution_host, runtime_session_id, status, last_activity_at, updated_at
         FROM gateway_sessions
         WHERE runtime_session_id = ?
         LIMIT 20`,
      )
      .all(thread.runtimeId);
    const matched = pickBestGateway(rows, thread.backend, thread.host ?? null);
    if (matched) return loadGatewayRow(matched.id);
  }
  return null;
}

function findThreadForGateway(row: GatewaySessionRow): ChatThread | null {
  const chats = new ChatStore(getSqlite());
  const bySource = chats.bySource(row.id);
  if (bySource) return bySource;
  if (!row.runtime_session_id) return null;
  const sqlite = getSqlite();
  const candidates = sqlite
    .query<{ id: string; backend: string | null; host: string | null }, [string]>(
      `SELECT id, json_extract(data, '$.backend') AS backend, json_extract(data, '$.host') AS host
       FROM chat_threads
       WHERE json_valid(data) AND json_extract(data, '$.runtimeId') = ?
       ORDER BY updated_at DESC
       LIMIT 10`,
    )
    .all(row.runtime_session_id);
  const match = candidates.find(
    (entry) =>
      backendMatches(entry.backend, row.backend) &&
      (entry.host ?? null) === (row.execution_host ?? null),
  );
  return match ? chats.get(match.id) : null;
}

function findThreadByRuntimeId(runtimeId: string, backend?: string): ChatThread | null {
  const sqlite = getSqlite();
  const chats = new ChatStore(sqlite);
  const candidates = sqlite
    .query<{ id: string; backend: string | null }, [string]>(
      `SELECT id, json_extract(data, '$.backend') AS backend
       FROM chat_threads
       WHERE json_valid(data) AND json_extract(data, '$.runtimeId') = ?
       ORDER BY updated_at DESC
       LIMIT 10`,
    )
    .all(runtimeId);
  const matched = backend
    ? candidates.find((entry) => backendMatches(entry.backend, backend))
    : candidates[0];
  return matched ? chats.get(matched.id) : null;
}

export function resolveSessionRef(
  identifier: string,
  opts: { backend?: string } = {},
): ResolvedSession | null {
  const sqlite = getSqlite();
  const chats = new ChatStore(sqlite);

  const directThread = chats.get(identifier);
  if (directThread) {
    const gateway = findGatewayForThread(directThread);
    return {
      thread: directThread,
      gateway,
      canonicalId: directThread.id,
      chatId: directThread.id,
      liveId: gateway?.id ?? directThread.sourceId ?? null,
      nativeId: directThread.runtimeId ?? gateway?.runtime_session_id ?? null,
      backend: directThread.backend,
    };
  }

  const directGateway = loadGatewayRow(identifier);
  if (directGateway) {
    const thread = findThreadForGateway(directGateway);
    return {
      thread,
      gateway: directGateway,
      canonicalId: thread?.id ?? directGateway.id,
      chatId: thread?.id ?? null,
      liveId: directGateway.id,
      nativeId: directGateway.runtime_session_id ?? thread?.runtimeId ?? null,
      backend: thread?.backend ?? directGateway.backend,
    };
  }

  const nativeRows = sqlite
    .query<GatewayLookupId, [string]>(
      `SELECT id, chat_id, backend, execution_host, runtime_session_id, status, last_activity_at, updated_at
       FROM gateway_sessions
       WHERE runtime_session_id = ?
       LIMIT 20`,
    )
    .all(identifier);
  const picked = pickBestGateway(nativeRows, opts.backend);
  if (picked) {
    const gateway = loadGatewayRow(picked.id);
    if (gateway) {
      const thread = findThreadForGateway(gateway);
      return {
        thread,
        gateway,
        canonicalId: thread?.id ?? gateway.id,
        chatId: thread?.id ?? null,
        liveId: gateway.id,
        nativeId: gateway.runtime_session_id ?? identifier,
        backend: thread?.backend ?? gateway.backend,
      };
    }
  }

  const threadByNative = findThreadByRuntimeId(identifier, opts.backend);
  if (threadByNative) {
    const gateway = findGatewayForThread(threadByNative);
    return {
      thread: threadByNative,
      gateway,
      canonicalId: threadByNative.id,
      chatId: threadByNative.id,
      liveId: gateway?.id ?? threadByNative.sourceId ?? null,
      nativeId: threadByNative.runtimeId ?? identifier,
      backend: threadByNative.backend,
    };
  }

  return null;
}

type TranscriptBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; name: string; input: string; id?: string; result?: string }
  | { type: "tool_result"; text: string; forId?: string };

type TranscriptTurn = {
  index: number;
  role: "user" | "assistant" | "tool" | "system";
  time: string | null;
  blocks: TranscriptBlock[];
};

function messageBlocks(message: ChatMessage): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const item of message.activity ?? []) {
    if (item.type === "thinking") {
      blocks.push({ type: "thinking", text: item.text });
    } else if (item.type === "tool") {
      blocks.push({
        type: "tool_use",
        name: item.name,
        input: item.input,
        id: item.id,
        ...(item.result !== undefined ? { result: item.result } : {}),
      });
    } else if (item.type === "status") {
      blocks.push({ type: "text", text: item.text });
    }
  }
  if (message.content) blocks.push({ type: "text", text: message.content });
  if (!blocks.length && message.turn?.error)
    blocks.push({ type: "text", text: message.turn.error });
  return blocks;
}

export function chatThreadTranscript(
  thread: ChatThread,
  opts: { offset: number; limit: number; q?: string | undefined },
): { total: number; offset: number; matches: number[]; turns: TranscriptTurn[] } {
  const turns: TranscriptTurn[] = thread.messages.map((message, index) => ({
    index,
    role: message.role,
    time: Number.isFinite(message.timestamp) ? new Date(message.timestamp).toISOString() : null,
    blocks: messageBlocks(message),
  }));
  const query = opts.q?.trim().toLowerCase();
  const matches = query
    ? turns
        .filter((turn) =>
          turn.blocks.some((block) =>
            ("text" in block ? block.text : `${block.name} ${block.input} ${block.result ?? ""}`)
              .toLowerCase()
              .includes(query),
          ),
        )
        .map((turn) => turn.index)
    : [];
  const offset = Math.max(0, opts.offset);
  const limit = Math.max(1, opts.limit);
  return {
    total: turns.length,
    offset,
    matches,
    turns: turns.slice(offset, offset + limit),
  };
}
