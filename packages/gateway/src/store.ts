import { ulid } from "@orc/core/ids";
import type { GatewayMode, GatewayPlatform } from "@orc/core/types";
import { getDb } from "@orc/db/client";
import {
  bridge_chats,
  bridge_messages,
  bridge_permissions,
  gateway_sessions,
  job_runs,
  jobs,
  memories,
  comments,
  tasks,
} from "@orc/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";

export async function getOrCreateChat(input: {
  platform: GatewayPlatform;
  chatId: string;
  username?: string | undefined;
  displayName?: string | undefined;
  authorized: boolean;
  mode: GatewayMode;
  threadId?: string | undefined;
}): Promise<typeof bridge_chats.$inferSelect> {
  const db = getDb();
  const id = `${input.platform}:${input.chatId}`;
  const existing = await db.query.bridge_chats.findFirst({ where: eq(bridge_chats.id, id) });
  if (existing) {
    await db
      .update(bridge_chats)
      .set({
        username: input.username ?? existing.username,
        display_name: input.displayName ?? existing.display_name,
        authorized: input.authorized,
        thread_id: input.threadId ?? existing.thread_id,
        updated_at: new Date(),
      })
      .where(eq(bridge_chats.id, id));
    return (await db.query.bridge_chats.findFirst({ where: eq(bridge_chats.id, id) })) ?? existing;
  }

  await db.insert(bridge_chats).values({
    id,
    platform: input.platform,
    chat_id: input.chatId,
    username: input.username,
    display_name: input.displayName,
    authorized: input.authorized,
    mode: input.mode,
    thread_id: input.threadId,
    updated_at: new Date(),
    created_at: new Date(),
  });
  return (await db.query.bridge_chats.findFirst({
    where: eq(bridge_chats.id, id),
  })) as typeof bridge_chats.$inferSelect;
}

export async function updateChatMode(chatKey: string, mode: GatewayMode): Promise<void> {
  const db = getDb();
  await db
    .update(bridge_chats)
    .set({ mode, updated_at: new Date() })
    .where(eq(bridge_chats.id, chatKey));
}

export async function updateChatWorkingDir(chatKey: string, workingDir: string): Promise<void> {
  const db = getDb();
  await db
    .update(bridge_chats)
    .set({ working_dir: workingDir, updated_at: new Date() })
    .where(eq(bridge_chats.id, chatKey));
}

export async function appendMessage(input: {
  chatKey: string;
  direction: "in" | "out";
  role: "system" | "user" | "assistant";
  text: string;
  platformMessageId?: string | undefined;
  gatewaySessionId?: string | undefined;
  threadId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}): Promise<void> {
  const db = getDb();
  await db.insert(bridge_messages).values({
    id: ulid(),
    chat_id: input.chatKey,
    direction: input.direction,
    role: input.role,
    text: input.text,
    platform_msg_id: input.platformMessageId,
    gateway_session_id: input.gatewaySessionId,
    thread_id: input.threadId,
    metadata: input.metadata,
    created_at: new Date(),
  });
}

export async function listRecentMessages(chatKey: string, gatewaySessionId?: string, limit = 12) {
  const db = getDb();
  return db.query.bridge_messages.findMany({
    where: gatewaySessionId
      ? and(
          eq(bridge_messages.chat_id, chatKey),
          eq(bridge_messages.gateway_session_id, gatewaySessionId),
        )
      : eq(bridge_messages.chat_id, chatKey),
    limit,
    orderBy: [desc(bridge_messages.created_at)],
  });
}

export async function createGatewaySession(input: {
  chatKey: string;
  backend: "claude" | "codex" | "cursor";
  cwd?: string | undefined;
  mode: GatewayMode;
  title?: string | undefined;
}): Promise<typeof gateway_sessions.$inferSelect> {
  const db = getDb();
  const id = ulid();
  const now = new Date();
  await db.insert(gateway_sessions).values({
    id,
    chat_id: input.chatKey,
    backend: input.backend,
    cwd: input.cwd,
    mode: input.mode,
    title: input.title,
    status: "idle",
    last_activity_at: now,
    created_at: now,
    updated_at: now,
  });
  await db
    .update(bridge_chats)
    .set({ session_id: id, updated_at: now })
    .where(eq(bridge_chats.id, input.chatKey));
  return (await db.query.gateway_sessions.findFirst({
    where: eq(gateway_sessions.id, id),
  })) as typeof gateway_sessions.$inferSelect;
}

export async function getActiveGatewaySession(chatKey: string) {
  const db = getDb();
  const chat = await db.query.bridge_chats.findFirst({ where: eq(bridge_chats.id, chatKey) });
  if (chat?.session_id) {
    const current = await db.query.gateway_sessions.findFirst({
      where: eq(gateway_sessions.id, chat.session_id),
    });
    if (current) return current;
  }
  return db.query.gateway_sessions.findFirst({
    where: eq(gateway_sessions.chat_id, chatKey),
    orderBy: [desc(gateway_sessions.updated_at)],
  });
}

export async function listGatewaySessions(chatKey: string) {
  const db = getDb();
  return db.query.gateway_sessions.findMany({
    where: eq(gateway_sessions.chat_id, chatKey),
    orderBy: [desc(gateway_sessions.updated_at)],
    limit: 20,
  });
}

export async function setActiveGatewaySession(
  chatKey: string,
  gatewaySessionId: string | null,
): Promise<void> {
  const db = getDb();
  await db
    .update(bridge_chats)
    .set({ session_id: gatewaySessionId, updated_at: new Date() })
    .where(eq(bridge_chats.id, chatKey));
}

export async function updateGatewaySession(
  sessionId: string,
  updates: Partial<typeof gateway_sessions.$inferInsert>,
): Promise<void> {
  const db = getDb();
  await db
    .update(gateway_sessions)
    .set({ ...updates, updated_at: new Date() })
    .where(eq(gateway_sessions.id, sessionId));
}

export async function createPermission(input: {
  chatKey: string;
  gatewaySessionId?: string | undefined;
  tool: string;
  command?: string | undefined;
  message?: string | undefined;
  scope?: "once" | "session" | undefined;
  expiresAt?: Date | undefined;
}): Promise<typeof bridge_permissions.$inferSelect> {
  const db = getDb();
  const id = ulid();
  await db.insert(bridge_permissions).values({
    id,
    chat_id: input.chatKey,
    gateway_session_id: input.gatewaySessionId,
    tool: input.tool,
    command: input.command,
    message: input.message,
    scope: input.scope ?? "once",
    expires_at: input.expiresAt,
    created_at: new Date(),
  });
  return (await db.query.bridge_permissions.findFirst({
    where: eq(bridge_permissions.id, id),
  })) as typeof bridge_permissions.$inferSelect;
}

export async function resolvePermission(permissionId: string, approved: boolean): Promise<boolean> {
  const db = getDb();
  const permission = await db.query.bridge_permissions.findFirst({
    where: eq(bridge_permissions.id, permissionId),
  });
  if (!permission || permission.status !== "pending") return false;
  await db
    .update(bridge_permissions)
    .set({ status: approved ? "approved" : "denied", resolved_at: new Date() })
    .where(eq(bridge_permissions.id, permissionId));
  return true;
}

export async function findPermission(input: string) {
  const db = getDb();
  if (input.length === 26) {
    return db.query.bridge_permissions.findFirst({ where: eq(bridge_permissions.id, input) });
  }
  const rows = await db.query.bridge_permissions.findMany({
    limit: 20,
    orderBy: [desc(bridge_permissions.created_at)],
  });
  return rows.find((row) => row.id.endsWith(input));
}

export async function findTask(input: string) {
  const db = getDb();
  if (input.length === 26) return db.query.tasks.findFirst({ where: eq(tasks.id, input) });
  const rows = await db.query.tasks.findMany({ limit: 100, orderBy: [desc(tasks.updated_at)] });
  return rows.find((row) => row.id.endsWith(input) || row.id === input);
}

export async function approveTask(
  taskId: string,
  note?: string,
): Promise<typeof tasks.$inferSelect | null> {
  const db = getDb();
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  if (!task) return null;
  const now = new Date();
  await db.update(tasks).set({ status: "done", updated_at: now }).where(eq(tasks.id, taskId));
  if (note) {
    await db.insert(comments).values({
      id: ulid(),
      resource_type: "task",
      resource_id: taskId,
      content: note,
      author: "human",
      created_at: now,
    });
  }
  return (await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) })) ?? null;
}

export async function rejectTask(
  taskId: string,
  note?: string,
): Promise<typeof tasks.$inferSelect | null> {
  const db = getDb();
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  if (!task) return null;
  const now = new Date();
  await db
    .update(tasks)
    .set({ status: "changes_requested", updated_at: now })
    .where(eq(tasks.id, taskId));
  if (note) {
    await db.insert(comments).values({
      id: ulid(),
      resource_type: "task",
      resource_id: taskId,
      content: note,
      author: "human",
      created_at: now,
    });
  }
  return (await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) })) ?? null;
}

export async function listActiveTasks(limit = 8) {
  const db = getDb();
  const rows = await db.query.tasks.findMany({ limit, orderBy: [desc(tasks.updated_at)] });
  return rows.filter((row) => !["done", "cancelled"].includes(row.status));
}

export async function searchMemories(query: string, limit = 5) {
  const db = getDb();
  const rows = await db.query.memories.findMany({
    limit: limit * 3,
    orderBy: [desc(memories.created_at)],
  });
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows
    .filter((row) =>
      terms.every(
        (term) =>
          row.content.toLowerCase().includes(term) || row.title?.toLowerCase().includes(term),
      ),
    )
    .slice(0, limit);
}

export async function findJobByName(name: string) {
  const db = getDb();
  return db.query.jobs.findFirst({ where: eq(jobs.name, name) });
}

export async function listJobs(limit = 10) {
  const db = getDb();
  return db.query.jobs.findMany({ limit, orderBy: [desc(jobs.updated_at)] });
}

export async function listReviewTargets() {
  const db = getDb();
  return db.query.bridge_chats.findMany({
    where: and(
      eq(bridge_chats.authorized, true),
      inArray(bridge_chats.platform, ["telegram", "slack"]),
    ),
    orderBy: [desc(bridge_chats.updated_at)],
  });
}

export async function listGatewayChats() {
  const db = getDb();
  return db.query.bridge_chats.findMany({ orderBy: [desc(bridge_chats.updated_at)] });
}

export async function listGatewayRunLinks(jobRunId: string) {
  const db = getDb();
  return db.query.job_runs.findMany({ where: eq(job_runs.id, jobRunId), limit: 1 });
}

export async function assignTaskToSession(sessionId: string, taskId: string): Promise<void> {
  const db = getDb();
  await db
    .update(gateway_sessions)
    .set({ task_id: taskId, updated_at: new Date() })
    .where(eq(gateway_sessions.id, sessionId));
}

export async function resolveChatKey(platform: string, chatIdOrKey: string): Promise<string> {
  if (chatIdOrKey.includes(":")) return chatIdOrKey;
  const db = getDb();
  const chat = await db.query.bridge_chats.findFirst({
    where: eq(bridge_chats.id, `${platform}:${chatIdOrKey}`),
  });
  return chat?.id ?? `${platform}:${chatIdOrKey}`;
}
