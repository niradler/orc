import type { HumanRequest } from "@orc/core/human-requests";
import type { LiveSession } from "@/api/client";
import type { ChatTab } from "@/hooks/useChat";
import type { NotifySubject } from "./agent-notifications";
import { type AgentState, liveSessionState, moreUrgent } from "./agent-state";

export type NotifyChatTab = Pick<
  ChatTab,
  | "thread"
  | "config"
  | "projectId"
  | "permissions"
  | "questions"
  | "error"
  | "streaming"
  | "attention"
>;
export interface NotifyChatWait {
  thread_id: string;
  title: string;
  agent: string;
  native_session_id: string | null;
  host: string | null;
}

const nativeKey = (agent: string, host: string | null | undefined, id: string) =>
  `native:${JSON.stringify([agent.replace(/-cli$/, ""), host ?? null, id])}`;

export function chatTabState(tab: NotifyChatTab): AgentState {
  if (tab.permissions.length || tab.questions.length) return "needs-you";
  if (tab.error) return "failed";
  if (tab.streaming) return "working";
  return tab.attention ? "done" : "idle";
}

const clip = (text: string) => (text.length > 140 ? `${text.slice(0, 139)}…` : text);

/** One subject per conversation or native session, merged across every source that reports it. */
export function notifySubjects(sources: {
  tabs: readonly NotifyChatTab[];
  waits: readonly NotifyChatWait[];
  requests: readonly HumanRequest[];
  sessions: readonly LiveSession[];
}): NotifySubject[] {
  const subjects = new Map<string, NotifySubject>();
  const aliases = new Map<string, string>();
  const requestCounts = new Map<string, number>();
  const add = (subject: NotifySubject) => {
    const key = aliases.get(subject.key) ?? subject.key;
    const existing = subjects.get(key);
    if (!existing) {
      subjects.set(key, { ...subject, key });
      return;
    }
    existing.state = moreUrgent(existing.state, subject.state);
    existing.title ||= subject.title;
    existing.projectId ??= subject.projectId;
    existing.detail ??= subject.detail;
    existing.approval ??= subject.approval;
    if (subject.liveIds)
      existing.liveIds = [...new Set([...(existing.liveIds ?? []), ...subject.liveIds])];
  };
  for (const tab of sources.tabs) {
    if (!tab.thread) continue;
    const key = `chat:${tab.thread.id}`;
    if (tab.thread.runtimeId)
      aliases.set(nativeKey(tab.config.agent, tab.thread.host, tab.thread.runtimeId), key);
    add({
      key,
      state: chatTabState(tab),
      title: tab.thread.title || "New session",
      agent: tab.config.agent,
      projectId: tab.projectId ?? null,
      target: { kind: "chat", threadId: tab.thread.id },
    });
  }
  for (const wait of sources.waits) {
    const key = `chat:${wait.thread_id}`;
    if (wait.native_session_id)
      aliases.set(nativeKey(wait.agent, wait.host, wait.native_session_id), key);
    add({
      key,
      state: "needs-you",
      title: wait.title || "Chat session",
      agent: wait.agent,
      projectId: null,
      target: { kind: "chat", threadId: wait.thread_id },
    });
  }
  for (const request of sources.requests) {
    if (request.status !== "pending" && request.status !== "unavailable") continue;
    const { origin } = request.input;
    const key = origin.chat_thread_id
      ? `chat:${origin.chat_thread_id}`
      : nativeKey(
          origin.backend,
          origin.execution_host,
          origin.native_session_id ?? origin.session_id,
        );
    const resolved = aliases.get(key) ?? key;
    const pending = request.status === "pending";
    if (pending) requestCounts.set(resolved, (requestCounts.get(resolved) ?? 0) + 1);
    add({
      key,
      state: pending ? "needs-you" : "failed",
      title: origin.session_title ?? "",
      agent: origin.backend,
      projectId: request.input.project_id,
      target: origin.chat_thread_id
        ? { kind: "chat", threadId: origin.chat_thread_id }
        : { kind: "attention" },
      detail: clip(request.input.title ?? request.input.prompt),
      ...(pending && request.input.kind === "approval" && request.input.action
        ? { approval: { id: request.id, version: request.version } }
        : {}),
    });
  }
  for (const session of sources.sessions) {
    add({
      key: session.session_id
        ? nativeKey(session.agent, session.host, session.session_id)
        : `live:${session.id}`,
      state: liveSessionState(session),
      title: session.name || session.summary || session.session_id || "Session",
      agent: session.agent,
      projectId: session.project_id,
      target: { kind: "session", id: session.id },
      liveIds: [session.id],
    });
  }
  return [...subjects.values()].map(({ approval, ...merged }) => {
    const subject = { ...merged, title: merged.title || `${merged.agent} session` };
    return approval && subject.state === "needs-you" && requestCounts.get(subject.key) === 1
      ? { ...subject, approval }
      : subject;
  });
}
