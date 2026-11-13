import type { Database } from "bun:sqlite";
import { changes } from "@orc/core/changes";
import type { ChatThread } from "@orc/core/chat";
import { loadConfig } from "@orc/core/config";
import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { cleanupAuditLog } from "@orc/db/audit";
import { ChatStore } from "@orc/db/chat";
import { getSqlite } from "@orc/db/client";
import { HumanRequestStore } from "@orc/db/human-requests";
import { notificationProjectLabel, publishNotification } from "@orc/db/notification-producers";
import { NotificationStore } from "@orc/db/notifications";
import { notify, sessionWaitingMessage } from "./push/service.js";
import { activeTurns, turnKey } from "./sessions/turns.js";

const logger = createLogger("notifications");
const observedTimers = new Map<string, ReturnType<typeof setTimeout>>();

function sessionBackends(backend: string): string[] {
  return backend === "codex" || backend === "codex-cli" ? ["codex", "codex-cli"] : [backend];
}

function associateSessionSources(
  sqlite: Database,
  sourceId: string,
  backend: string,
  host: string | null,
  runtimeId: string,
): void {
  const notifications = new NotificationStore(sqlite);
  const backends = sessionBackends(backend);
  const key = JSON.stringify([backends[0], host, runtimeId]);
  sqlite
    .transaction(() => {
      notifications.associateSession(sourceId, key);
      for (const candidate of backends) {
        for (const thread of new ChatStore(sqlite).byRuntime(candidate, host, runtimeId)) {
          notifications.associateSession(thread.id, key);
          if (
            thread.sourceId &&
            thread.sourceId.length <= 256 &&
            !sqlite.query("SELECT 1 FROM gateway_sessions WHERE id=?").get(thread.sourceId)
          )
            notifications.associateSession(thread.sourceId, key);
        }
        for (const source of sqlite
          .query<{ id: string }, [string, string | null, string]>(
            "SELECT id FROM gateway_sessions WHERE backend=? AND execution_host IS ? AND runtime_session_id=?",
          )
          .all(candidate, host, runtimeId))
          notifications.associateSession(source.id, key);
      }
    })
    .immediate();
}

export function syncFinishedNotificationSessions(sqlite: Database): void {
  const notifications = new NotificationStore(sqlite);
  const rows = sqlite
    .query<
      {
        source_id: string;
        backend: unknown;
        host: unknown;
        runtime_id: unknown;
      },
      []
    >(`SELECT DISTINCT n.source_id,
    coalesce(CASE WHEN json_valid(t.data) THEN json_extract(t.data,'$.backend') END,g.backend) AS backend,
    CASE WHEN t.id IS NOT NULL AND json_valid(t.data) THEN json_extract(t.data,'$.host') ELSE g.execution_host END AS host,
    coalesce(CASE WHEN json_valid(t.data) THEN json_extract(t.data,'$.runtimeId') END,g.runtime_session_id) AS runtime_id
    FROM notifications n LEFT JOIN chat_threads t ON t.id=n.source_id LEFT JOIN gateway_sessions g ON g.id=n.source_id
    WHERE n.type='agent.finished' AND NOT EXISTS (
      SELECT 1 FROM notification_session_sources s WHERE s.source_id=n.source_id) LIMIT 1000`)
    .all();
  for (const row of rows) {
    if (
      typeof row.backend === "string" &&
      row.backend.length > 0 &&
      row.backend.length <= 100 &&
      typeof row.runtime_id === "string" &&
      row.runtime_id.length > 0 &&
      row.runtime_id.length <= 256 &&
      (row.host === null || (typeof row.host === "string" && row.host.length <= 256))
    )
      associateSessionSources(sqlite, row.source_id, row.backend, row.host, row.runtime_id);
    else notifications.associateSession(row.source_id, `source:${row.source_id}`);
  }
}

export function retireChatFinishedNotifications(thread: ChatThread): void {
  if (thread.runtimeId)
    associateSessionSources(getSqlite(), thread.id, thread.backend, thread.host, thread.runtimeId);
  const notifications = new NotificationStore(getSqlite());
  let count = notifications.markFinishedRead(thread.id);
  if (thread.sourceId) count += notifications.markFinishedRead(thread.sourceId);
  if (count) changes.publish("notifications");
}

export function recordChatNotification(
  thread: ChatThread,
  eventId: string,
  kind: "question" | "approval" | "finished" | "failed",
): void {
  const sqlite = getSqlite();
  const waiting = kind === "question" || kind === "approval";
  if (kind === "finished" && thread.runtimeId)
    associateSessionSources(sqlite, thread.id, thread.backend, thread.host, thread.runtimeId);
  if (
    waiting &&
    sqlite
      .query(
        "SELECT 1 FROM human_requests WHERE status='pending' AND json_extract(payload,'$.origin.chat_thread_id')=? LIMIT 1",
      )
      .get(thread.id)
  )
    return;
  publishNotification(sqlite, {
    type: `agent.${kind}`,
    source_key: `chat:${thread.id}:${eventId}`,
    source_id: thread.id,
    title: thread.title || "Chat session",
    body: waiting
      ? `The agent is waiting for your ${kind === "question" ? "answer" : "approval"}.`
      : kind === "failed"
        ? "The agent could not complete the turn. Open the session for details."
        : "The agent finished its reply.",
    level: kind === "finished" ? "done" : "needs-you",
    requires_action: waiting,
    project_id: thread.projectId ?? null,
    cwd: thread.cwd,
    path: `/activity?chat=open&chatThread=${encodeURIComponent(thread.id)}${thread.projectId ? `&project=${encodeURIComponent(thread.projectId)}` : ""}`,
  });
}

export function resolveChatNotification(threadId: string, eventId: string): void {
  new NotificationStore(getSqlite()).resolve(`chat:${threadId}:${eventId}`);
}

export function recordObservedNotification(
  event: {
    id: string;
    backend: string;
    host: string | null;
    nativeId: string;
    title: string;
    projectId: string | null;
    cwd?: string | null;
    previous: string | null;
    status: string;
    waiting: boolean;
    wasWaiting: boolean;
    activity: number;
  },
  stillCurrent: () => boolean,
): void {
  const sqlite = getSqlite();
  if (event.status === "running" && event.previous !== "running") {
    associateSessionSources(sqlite, event.id, event.backend, event.host, event.nativeId);
    const notifications = new NotificationStore(sqlite);
    const count = notifications.markFinishedRead(event.id);
    if (count) changes.publish("notifications");
  }
  if (!event.waiting) new NotificationStore(sqlite).resolveSource("agent.question", event.id);
  const kind =
    event.waiting && !event.wasWaiting
      ? "question"
      : event.previous === "running" && event.status !== "running" && !event.waiting
        ? "finished"
        : null;
  if (!kind) return;
  const backends = sessionBackends(event.backend);
  const managed = () =>
    backends.some((backend) => {
      const threads = new ChatStore(sqlite).byRuntime(backend, event.host, event.nativeId);
      return (
        activeTurns.has(turnKey(event.host, backend, event.nativeId)) ||
        threads.some(
          (thread) =>
            activeTurns.has(thread.id) ||
            (kind === "finished" &&
              sqlite
                .query(
                  "SELECT 1 FROM notifications WHERE source_id=? AND type IN ('agent.finished','agent.failed') AND created_at>=? LIMIT 1",
                )
                .get(thread.id, event.activity)),
        )
      );
    });
  if (managed()) return;
  const transitionId = ulid();
  const previous = observedTimers.get(event.id);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    observedTimers.delete(event.id);
    try {
      if (!stillCurrent() || managed()) return;
      if (
        kind === "question" &&
        backends.some((backend) =>
          sqlite
            .query(`SELECT 1 FROM human_requests WHERE status IN ('pending','unavailable')
        AND json_extract(payload,'$.origin.backend')=? AND coalesce(json_extract(payload,'$.origin.execution_host'),'')=?
        AND coalesce(json_extract(payload,'$.origin.native_session_id'),json_extract(payload,'$.origin.session_id'))=? LIMIT 1`)
            .get(backend, event.host ?? "", event.nativeId),
        )
      )
        return;
      if (
        kind === "question" &&
        sqlite
          .query(
            "SELECT 1 FROM notifications WHERE type='agent.question' AND source_id=? AND requires_action=1 LIMIT 1",
          )
          .get(event.id)
      )
        return;
      if (kind === "finished")
        associateSessionSources(sqlite, event.id, event.backend, event.host, event.nativeId);
      const project = notificationProjectLabel(sqlite, event.projectId, event.cwd);
      publishNotification(sqlite, {
        type: `agent.${kind}`,
        source_key: `observed:${event.id}:${kind}:${transitionId}`,
        source_id: event.id,
        title: event.title || "Agent session",
        body: `${event.backend} · ${event.host ?? "local"}. ${kind === "question" ? "Reply in the original session." : "The agent finished its turn."}`,
        level: kind === "question" ? "needs-you" : "done",
        requires_action: kind === "question",
        project_id: event.projectId,
        cwd: event.cwd ?? null,
        path: `/sessions?session=${encodeURIComponent(event.id)}&project=all`,
      });
      if (kind === "question") notify("attention", sessionWaitingMessage({ ...event, project }));
    } catch (error) {
      logger.error("Could not record session notification", error);
    }
  }, 1000);
  timer.unref();
  observedTimers.set(event.id, timer);
}

export function syncRequestNotifications(sqlite: Database): void {
  const requests = new HumanRequestStore(sqlite);
  // Upgrade existing requests once; expired events must never be recreated by a scan.
  requests.list();
  const cutoff =
    Date.now() - (loadConfig().preferences.notification_retention_days ?? 30) * 86400000;
  for (const row of sqlite
    .query<{ id: string }, [number]>(
      `SELECT id FROM human_requests r WHERE status IN ('pending','unavailable') AND created_at>?
     AND NOT EXISTS(SELECT 1 FROM notifications n WHERE n.source_key='human:'||r.id) LIMIT 1000`,
    )
    .all(cutoff))
    requests.get(row.id);
  const notifications = new NotificationStore(sqlite);
  for (const row of sqlite
    .query<
      { source_key: string },
      []
    >(`SELECT source_key FROM notifications WHERE requires_action=1 AND type='human.request'
    AND source_id IN (SELECT id FROM human_requests WHERE status NOT IN ('pending','unavailable')) LIMIT 1000`)
    .all())
    notifications.resolve(row.source_key);
}

export function maintainNotifications(sqlite: Database = getSqlite()): void {
  syncFinishedNotificationSessions(sqlite);
  syncRequestNotifications(sqlite);
  new NotificationStore(sqlite).cleanup();
  cleanupAuditLog(sqlite, loadConfig().preferences.audit_retention_days ?? 90);
}

export function startNotificationMaintenance(): () => void {
  const run = () => {
    try {
      maintainNotifications();
    } catch (error) {
      logger.error("Notification and audit cleanup failed", error);
    }
  };
  run();
  const timer = setInterval(run, 60_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    for (const timer of observedTimers.values()) clearTimeout(timer);
    observedTimers.clear();
  };
}
