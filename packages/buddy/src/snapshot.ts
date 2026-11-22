import type { HumanRequest } from "@orc/core/human-requests";
import type { OrcNotification } from "@orc/core/notifications";
import type { LiveSession } from "@orc/sdk/types";
import {
  BUDDY_PROTOCOL_VERSION,
  type BuddyMood,
  type BuddyNeedsYou,
  type BuddySnapshot,
} from "./protocol.js";

/** A pending ORC chat-run request, normalized from the thread's live SSE replay. */
export type ChatPendingRequest = {
  runId: string;
  requestId: string;
  threadId: string;
  kind: "approval" | "question";
  title: string;
  /** Tool + command for approvals; the first question text for questions. */
  hint: string;
  projectId: string | null;
  /** Option labels of the first question, when it has options. */
  choices: string[];
  /** Question ids of a chat question; answering requires all of them. */
  questionIds?: string[];
  /** True when the device can answer: approval, or a single option-based question. */
  answerable: boolean;
};

export type SnapshotInput = {
  /** Unix milliseconds. */
  now: number;
  sessions: LiveSession[];
  notifications: OrcNotification[];
  humanRequests: HumanRequest[];
  chatPending: ChatPendingRequest[];
  projects: { id: string; name: string }[];
  unread: number;
  tokensToday: number | null;
  /** Celebrate mood holds until this timestamp (ms) after a fresh completion. */
  celebrateUntil?: number;
};

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

export function sessionWorking(session: LiveSession): boolean {
  return (
    session.status === "running" ||
    (session.working_children ?? 0) > 0 ||
    session.background_work === true
  );
}

export function sessionWaiting(session: LiveSession): boolean {
  return (
    session.waiting_for_human === true ||
    !!session.waiting_for ||
    (session.waiting_children ?? 0) > 0
  );
}

function projectName(projects: { id: string; name: string }[], id: string | null): string | null {
  if (!id) return null;
  return projects.find((project) => project.id === id)?.name ?? null;
}

function humanRequestItems(
  requests: HumanRequest[],
  projects: { id: string; name: string }[],
): BuddyNeedsYou[] {
  const items: BuddyNeedsYou[] = [];
  for (const request of requests) {
    if (request.status !== "pending") continue;
    const { input } = request;
    const project = projectName(projects, input.project_id);
    if (input.kind === "approval") {
      items.push({
        id: request.id,
        kind: "approval",
        title: truncate(input.title ?? "Approval needed", 200),
        hint: truncate(input.prompt, 300),
        project,
        actionable: true,
      });
    } else if (input.kind === "question") {
      items.push({
        id: request.id,
        kind: "question",
        title: truncate(input.title ?? "Question", 200),
        hint: truncate(input.prompt, 300),
        project,
        actionable: input.choices.length > 0,
        ...(input.choices.length
          ? { choices: input.choices.slice(0, 20).map((choice) => truncate(choice, 200)) }
          : {}),
      });
    }
    // Command requests run from the web review card only; they stay in the inbox.
  }
  return items;
}

function chatItems(
  pending: ChatPendingRequest[],
  projects: { id: string; name: string }[],
): BuddyNeedsYou[] {
  return pending.map((request) => ({
    id: `chat:${request.runId}:${request.requestId}`,
    kind: request.kind === "approval" ? ("approval" as const) : ("question" as const),
    title: truncate(request.title, 200),
    hint: truncate(request.hint, 300),
    project: projectName(projects, request.projectId),
    actionable: request.answerable,
    ...(request.choices.length
      ? { choices: request.choices.slice(0, 20).map((choice) => truncate(choice, 200)) }
      : {}),
  }));
}

/** Native terminal waits the device cannot answer: shown so the mood stays honest. */
function nativeItems(
  sessions: LiveSession[],
  requests: HumanRequest[],
  pending: ChatPendingRequest[],
  projects: { id: string; name: string }[],
): BuddyNeedsYou[] {
  const covered = new Set<string>();
  for (const request of requests) {
    if (request.status === "pending") covered.add(request.input.origin.session_id);
  }
  for (const request of pending) covered.add(request.threadId);
  const items: BuddyNeedsYou[] = [];
  for (const session of sessions) {
    if (!sessionWaiting(session) || covered.has(session.id)) continue;
    const reason = session.waiting_for?.reason;
    items.push({
      id: `native:${session.id}`,
      kind: "native",
      title: truncate(session.name ?? session.agent, 200),
      hint: truncate(
        reason === "permission"
          ? `Waiting on ${session.waiting_for?.tool ?? "a permission"} — answer in the terminal`
          : "Waiting for you — answer in the terminal",
        300,
      ),
      project: projectName(projects, session.project_id),
      actionable: false,
    });
  }
  return items;
}

export function composeSnapshot(input: SnapshotInput): BuddySnapshot {
  const { now, sessions, notifications, humanRequests, chatPending, projects } = input;
  const working = sessions.filter(sessionWorking).length;
  const waiting = sessions.filter(sessionWaiting).length;

  const needsYou = [
    ...humanRequestItems(humanRequests, projects),
    ...chatItems(chatPending, projects),
    ...nativeItems(sessions, humanRequests, chatPending, projects),
  ];
  // Actionable first, then the rest; the device shows the head of the list.
  needsYou.sort((a, b) => Number(b.actionable) - Number(a.actionable));

  let mood: BuddyMood = "idle";
  if (needsYou.length > 0) mood = "attention";
  else if (working > 0) mood = "busy";
  else if (sessions.some((session) => session.status === "error")) mood = "error";
  else if ((input.celebrateUntil ?? 0) > now) mood = "celebrate";

  const recent = [...notifications]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 6)
    .map((notification) => {
      const at = new Date(notification.created_at);
      const hh = String(at.getHours()).padStart(2, "0");
      const mm = String(at.getMinutes()).padStart(2, "0");
      return {
        id: notification.id,
        line: truncate(`${hh}:${mm} ${notification.title}`, 160),
        unread: notification.read_at === null && notification.dismissed_at === null,
      };
    });

  return {
    v: BUDDY_PROTOCOL_VERSION,
    t: Math.floor(now / 1000),
    mood,
    sessions: { total: sessions.length, working, waiting },
    needs_you: needsYou.slice(0, 20),
    recent,
    unread: input.unread,
    tokens_today: input.tokensToday,
  };
}

/** Snapshots equal apart from their timestamp: the bridge skips re-sending those. */
export function snapshotBodyEqual(a: BuddySnapshot, b: BuddySnapshot): boolean {
  return JSON.stringify({ ...a, t: 0 }) === JSON.stringify({ ...b, t: 0 });
}
