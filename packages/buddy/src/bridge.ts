import type { HumanRequest } from "@orc/core/human-requests";
import { type BuddyApi, chatAnswerFromChoice, subscribeEvents, watchChatThread } from "./orc.js";
import {
  BUDDY_KEEPALIVE_MS,
  type BuddyAck,
  BuddyAckSchema,
  BuddyCommandSchema,
  type BuddySnapshot,
  encodeLine,
} from "./protocol.js";
import { type ChatPendingRequest, composeSnapshot, snapshotBodyEqual } from "./snapshot.js";

/** A duplex line channel: serial port, terminal simulator, or a test fake. */
export type BuddyTransport = {
  readonly label: string;
  send(line: string): void | Promise<void>;
  onMessage(handler: (value: unknown) => void): void;
  onClose(handler: () => void): void;
  close(): void | Promise<void>;
};

export type BridgeOptions = {
  api: BuddyApi;
  transport: BuddyTransport;
  /** Restrict sessions, notifications and requests to one project. */
  projectId?: string | null;
  keepaliveMs?: number;
  debounceMs?: number;
  log?: (message: string) => void;
};

export type BridgeHandle = {
  stop(): Promise<void>;
  snapshot(): BuddySnapshot | null;
  /** Resolves when the bridge stops (transport closed, or stop() called). */
  done: Promise<void>;
};

const RELEVANT_RESOURCES = new Set([
  "sessions",
  "session-activity",
  "notifications",
  "human-requests",
  "usage",
]);

const CELEBRATE_MS = 5000;

export async function runBridge(options: BridgeOptions): Promise<BridgeHandle> {
  const { api, transport } = options;
  const log = options.log ?? (() => {});
  const keepaliveMs = options.keepaliveMs ?? BUDDY_KEEPALIVE_MS;
  const debounceMs = options.debounceMs ?? 300;
  const projectId = options.projectId ?? null;
  const controller = new AbortController();
  const startedAt = Date.now();
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  let sessions: Awaited<ReturnType<BuddyApi["sessions"]>> = [];
  let notifications: Awaited<ReturnType<BuddyApi["notifications"]>> = {
    notifications: [],
    unread: 0,
    has_more: false,
  };
  let humanRequests: HumanRequest[] = [];
  let projects: { id: string; name: string }[] = [];
  let tokensToday: number | null = null;
  const chatPending = new Map<string, ChatPendingRequest[]>();
  const watchers = new Map<string, AbortController>();
  const seenDone = new Set<string>();
  let celebrateUntil = 0;
  let last: BuddySnapshot | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshing = false;
  let pendingRefresh = false;
  let stopped = false;

  const send = (value: unknown) => {
    if (!stopped) void transport.send(encodeLine(value));
  };
  const ack = (command: string, ok: boolean, error?: string, data?: unknown) =>
    send({
      ack: command,
      ok,
      ...(error ? { error: error.slice(0, 300) } : {}),
      ...(data !== undefined ? { data } : {}),
    } satisfies BuddyAck);

  function allChatPending(): ChatPendingRequest[] {
    const all = [...chatPending.values()].flat();
    return projectId ? all.filter((request) => request.projectId === projectId) : all;
  }

  function compose(): BuddySnapshot {
    return composeSnapshot({
      now: Date.now(),
      sessions: projectId
        ? sessions.filter((session) => session.project_id === projectId)
        : sessions,
      notifications: notifications.notifications,
      humanRequests: projectId
        ? humanRequests.filter((request) => request.input.project_id === projectId)
        : humanRequests,
      chatPending: allChatPending(),
      projects,
      unread: notifications.unread,
      tokensToday,
      celebrateUntil,
    });
  }

  async function refresh(): Promise<void> {
    if (stopped) return;
    if (refreshing) {
      pendingRefresh = true;
      return;
    }
    refreshing = true;
    try {
      const [sessionRows, notificationPage, requests, waiting, projectRows, tokens] =
        await Promise.all([
          api.sessions(),
          api.notifications(projectId ? { project_id: projectId } : {}),
          api.humanRequests(),
          api.chatWaiting(),
          api.projects(),
          api.tokensToday().catch(() => null),
        ]);
      sessions = sessionRows;
      notifications = notificationPage;
      humanRequests = requests;
      projects = projectRows;
      tokensToday = tokens;

      for (const notification of notificationPage.notifications) {
        if (
          notification.level === "done" &&
          notification.created_at > startedAt &&
          !seenDone.has(notification.id)
        ) {
          seenDone.add(notification.id);
          celebrateUntil = Date.now() + CELEBRATE_MS;
        }
      }

      syncWatchers(waiting.map((entry) => entry.thread_id));

      const snapshot = compose();
      if (!last || !snapshotBodyEqual(last, snapshot)) send(snapshot);
      last = snapshot;
    } catch (error) {
      log(`refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      refreshing = false;
      if (pendingRefresh && !stopped) {
        pendingRefresh = false;
        scheduleRefresh(0);
      }
    }
  }

  function scheduleRefresh(delay = debounceMs): void {
    if (stopped || refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, delay);
  }

  function syncWatchers(threadIds: string[]): void {
    const wanted = new Set(threadIds);
    for (const [threadId, watcher] of watchers) {
      if (!wanted.has(threadId)) {
        watcher.abort();
        watchers.delete(threadId);
        chatPending.delete(threadId);
      }
    }
    for (const threadId of wanted) {
      if (watchers.has(threadId)) continue;
      const watcher = new AbortController();
      watchers.set(threadId, watcher);
      watchChatThread(
        api,
        threadId,
        (pending) => {
          chatPending.set(threadId, pending);
          scheduleRefresh();
        },
        () => {
          watchers.delete(threadId);
          chatPending.delete(threadId);
          scheduleRefresh();
        },
        watcher.signal,
      );
    }
  }

  async function handleRespond(id: string, decision: "approve" | "deny"): Promise<void> {
    if (id.startsWith("chat:")) {
      const pending = allChatPending().find(
        (request) => `chat:${request.runId}:${request.requestId}` === id,
      );
      if (pending?.kind !== "approval") throw new Error("Approval is no longer pending.");
      await api.chatPermission(
        pending.runId,
        pending.requestId,
        decision === "approve" ? "approved" : "denied",
      );
      return;
    }
    const request = humanRequests.find((candidate) => candidate.id === id);
    if (request?.status !== "pending") throw new Error("Request is no longer pending.");
    if (request.input.kind !== "approval") throw new Error("Request is not an approval.");
    await api.respondHuman(id, { kind: "approval", approved: decision === "approve" });
  }

  async function handleAnswer(id: string, choice: string): Promise<void> {
    if (id.startsWith("chat:")) {
      const pending = allChatPending().find(
        (request) => `chat:${request.runId}:${request.requestId}` === id,
      );
      if (pending?.kind !== "question" || !pending.answerable)
        throw new Error("Question cannot be answered from the device.");
      const answers = chatAnswerFromChoice(pending, choice);
      if (!answers) throw new Error("Question cannot be answered from the device.");
      await api.chatAnswer(pending.runId, pending.requestId, answers);
      return;
    }
    const request = humanRequests.find((candidate) => candidate.id === id);
    if (request?.status !== "pending") throw new Error("Request is no longer pending.");
    if (request.input.kind !== "question") throw new Error("Request is not a question.");
    if (request.input.choices.length && !request.input.choices.includes(choice))
      throw new Error("Choice is not one of the offered options.");
    await api.respondHuman(id, { kind: "question", answer: choice, selected_choices: [choice] });
  }

  transport.onMessage((value) => {
    const ackParsed = BuddyAckSchema.safeParse(value);
    if (ackParsed.success) {
      log(
        `device ack ${ackParsed.data.ack}: ${ackParsed.data.ok ? "ok" : (ackParsed.data.error ?? "failed")}`,
      );
      return;
    }
    const parsed = BuddyCommandSchema.safeParse(value);
    if (!parsed.success) {
      const cmd = (value as { cmd?: unknown } | null)?.cmd;
      if (typeof cmd === "string") ack(cmd, false, "Malformed command.");
      return;
    }
    const command = parsed.data;
    void (async () => {
      try {
        if (command.cmd === "respond") {
          await handleRespond(command.id, command.decision);
          ack("respond", true);
        } else if (command.cmd === "answer") {
          await handleAnswer(command.id, command.choice);
          ack("answer", true);
        } else if (command.cmd === "read") {
          await api.markRead(command.id);
          ack("read", true);
        } else {
          ack("ping", true, undefined, { t: Math.floor(Date.now() / 1000) });
        }
        if (command.cmd !== "ping") scheduleRefresh();
      } catch (error) {
        ack(command.cmd, false, error instanceof Error ? error.message : String(error));
      }
    })();
  });

  transport.onClose(() => {
    log("transport closed");
    void stop();
  });

  subscribeEvents(
    api,
    (message) => {
      if (message.event === "ready") {
        scheduleRefresh(0);
        return;
      }
      if (message.event !== "change") return;
      try {
        const change = JSON.parse(message.data) as { resources?: string[] };
        if (change.resources?.some((resource) => RELEVANT_RESOURCES.has(resource)))
          scheduleRefresh();
      } catch {
        scheduleRefresh();
      }
    },
    controller.signal,
    (error) => log(`events stream: ${error instanceof Error ? error.message : String(error)}`),
  );

  const keepalive = setInterval(() => {
    if (last) send({ ...last, t: Math.floor(Date.now() / 1000) });
  }, keepaliveMs);

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    controller.abort();
    for (const watcher of watchers.values()) watcher.abort();
    watchers.clear();
    if (refreshTimer) clearTimeout(refreshTimer);
    clearInterval(keepalive);
    await transport.close();
    resolveDone();
  }

  await refresh();
  log(`bridge up on ${transport.label} → ${api.baseUrl}`);
  return { stop, snapshot: () => last, done };
}
