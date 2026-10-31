import { type ChatThread, nativeChatAgent } from "@orc/core/chat";
import type { ArchiveSession } from "@orc/core/session-archive";
import type { LiveSession } from "@/api/client";
import type { ChatTab } from "@/hooks/useChat";

type SavedChat = Pick<ChatThread, "id" | "title" | "updatedAt"> & {
  running: boolean;
  agent?: string | null;
  runtimeId?: string | null;
  sourceId?: string | null;
  host?: string | null;
};
type HistorySource =
  | { kind: "local"; tab: ChatTab }
  | { kind: "saved"; thread: SavedChat }
  | { kind: "native"; session: LiveSession }
  | { kind: "archive"; session: ArchiveSession };
export type ChatHistoryState = "idle" | "open" | "running" | "waiting" | "attention" | "error";
export type ChatHistoryEntry = HistorySource & {
  id: string;
  title: string;
  updatedAt: number;
  observedState?: ChatHistoryState;
  provider?: string;
  projectId?: string | null;
};

export function mergeHistoryState(a: ChatHistoryState, b: ChatHistoryState): ChatHistoryState {
  const priority = { idle: 0, open: 1, attention: 2, running: 3, error: 4, waiting: 5 };
  return priority[a] >= priority[b] ? a : b;
}

function observe(entry: ChatHistoryEntry, state: ChatHistoryState) {
  entry.observedState = mergeHistoryState(entry.observedState ?? "idle", state);
}

function timestamp(value: number | string | null | undefined): number {
  const result = typeof value === "number" ? value : value ? Date.parse(value) : 0;
  return Number.isFinite(result) ? result : 0;
}
const nativeKey = (agent: string, id: string, host?: string | null) =>
  JSON.stringify([host || null, agent === "cursor" ? "cursor-agent" : agent, id]);
const runtimeKey = (agent: string, id: string) => JSON.stringify([agent, id]);

/** A conversation's date, not its selected/open state, determines its position. */
export function chatHistoryList(
  tabs: readonly ChatTab[],
  saved: readonly SavedChat[],
  native: readonly LiveSession[],
  archived: readonly ArchiveSession[],
  query = "",
  projectScope = "all",
): ChatHistoryEntry[] {
  const matches = (text: string) => text.toLowerCase().includes(query.trim().toLowerCase());
  const entries: ChatHistoryEntry[] = [];
  const keywords = new Map<string, string>();
  const identities = new Map<string, ChatHistoryEntry>();
  const sources = new Map<string, ChatHistoryEntry>();
  const archiveMatches = new Set<string>();
  const chatIds = new Set(tabs.flatMap((tab) => (tab.thread ? [tab.thread.id] : [])));
  const savedDates = new Map(saved.map((thread) => [thread.id, thread.updatedAt]));
  for (const tab of tabs) {
    if (
      !tab.thread &&
      !tab.messages.length &&
      !tab.draft.trim() &&
      !tab.files.length &&
      !tab.queued.length &&
      !tab.streaming &&
      !tab.error &&
      !tab.permissions.length &&
      !tab.questions.length
    )
      continue;
    const title = tab.thread?.title || "New session";
    const entry: ChatHistoryEntry = {
      kind: "local",
      tab,
      projectId: tab.projectId,
      id: tab.thread ? `chat:${tab.thread.id}` : `draft:${tab.key}`,
      title,
      updatedAt: Math.max(
        timestamp(tab.thread?.updatedAt),
        timestamp(tab.thread && savedDates.get(tab.thread.id)),
        tab.messages.reduce((latest, message) => Math.max(latest, timestamp(message.timestamp)), 0),
        tab.thread ? 0 : timestamp(tab.createdAt),
      ),
    };
    entries.push(entry);
    keywords.set(entry.id, `${title} ${tab.config.agent} ${tab.thread?.cwd ?? ""}`);
    if (tab.thread?.runtimeId)
      identities.set(nativeKey(tab.config.agent, tab.thread.runtimeId, tab.thread.host), entry);
    if (tab.thread?.sourceId) sources.set(tab.thread.sourceId, entry);
  }
  for (const thread of [...saved].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
  )) {
    if (chatIds.has(thread.id)) {
      const entry = entries.find((entry) => entry.id === `chat:${thread.id}`);
      if (entry && thread.running) observe(entry, "running");
      continue;
    }
    const key =
      thread.agent && thread.runtimeId
        ? nativeKey(thread.agent, thread.runtimeId, thread.host)
        : null;
    const existing =
      (thread.sourceId ? sources.get(thread.sourceId) : undefined) ||
      (key ? identities.get(key) : undefined);
    if (existing) {
      if (thread.running) observe(existing, "running");
      existing.updatedAt = Math.max(existing.updatedAt, timestamp(thread.updatedAt));
      keywords.set(
        existing.id,
        `${keywords.get(existing.id) ?? existing.title} ${thread.title} ${thread.agent ?? ""}`,
      );
      if (thread.sourceId) sources.set(thread.sourceId, existing);
      if (key) identities.set(key, existing);
      continue;
    }
    const entry: ChatHistoryEntry = {
      kind: "saved",
      thread,
      id: `chat:${thread.id}`,
      title: thread.title,
      updatedAt: timestamp(thread.updatedAt),
      observedState: thread.running ? "running" : "idle",
    };
    entries.push(entry);
    keywords.set(entry.id, `${thread.title} ${thread.agent ?? ""}`);
    if (
      thread.agent &&
      thread.runtimeId &&
      !identities.has(nativeKey(thread.agent, thread.runtimeId, thread.host))
    )
      identities.set(nativeKey(thread.agent, thread.runtimeId, thread.host), entry);
    if (thread.sourceId && !sources.has(thread.sourceId)) sources.set(thread.sourceId, entry);
  }
  for (const session of native) {
    if (!nativeChatAgent(session.agent)) continue;
    const key = session.session_id
      ? nativeKey(session.agent, session.session_id, session.host)
      : null;
    const existing = sources.get(session.id) || (key ? identities.get(key) : undefined);
    const date = timestamp(session.last_activity_at || session.created_at);
    const entry: ChatHistoryEntry = existing ?? {
      kind: "native",
      session,
      id: `native:${session.id}`,
      title: session.name || session.session_id || "Session",
      updatedAt: date,
    };
    if (!existing) entries.push(entry);
    entry.provider ??= session.agent;
    entry.projectId = session.project_id;
    observe(
      entry,
      session.waiting_for_human
        ? "waiting"
        : session.status === "running"
          ? "running"
          : session.status === "error"
            ? "error"
            : session.status === "idle"
              ? "open"
              : "idle",
    );
    entry.updatedAt = Math.max(entry.updatedAt, date);
    keywords.set(
      entry.id,
      `${keywords.get(entry.id) ?? entry.title} ${session.name ?? ""} ${session.agent} ${session.cwd ?? ""}`,
    );
    if (key) identities.set(key, entry);
  }
  const candidates = new Map<string, Set<ChatHistoryEntry>>();
  for (const [identity, entry] of identities) {
    const [, agent, id] = JSON.parse(identity) as [string | null, string, string];
    const key = runtimeKey(agent, id);
    const matches = candidates.get(key) ?? new Set<ChatHistoryEntry>();
    matches.add(entry);
    candidates.set(key, matches);
  }
  const archiveSources = new Map<string, Set<string>>();
  for (const session of archived) {
    const key = runtimeKey(session.agent, session.native_id);
    const sources = archiveSources.get(key) ?? new Set<string>();
    sources.add(session.source_id);
    archiveSources.set(key, sources);
  }
  for (const session of archived) {
    const key = runtimeKey(session.agent, session.native_id);
    const matches = candidates.get(key);
    // Archives lack execution-host identity. Merge only an unambiguous alias.
    const existing =
      matches?.size === 1 && archiveSources.get(key)?.size === 1 ? [...matches][0] : undefined;
    const date = timestamp(session.updated_at);
    const entry: ChatHistoryEntry = existing ?? {
      kind: "archive",
      session,
      id: `archive:${session.id}`,
      title: session.title || session.native_id,
      updatedAt: date,
    };
    if (!existing) entries.push(entry);
    entry.provider ??= session.agent;
    if (entry.projectId === undefined) entry.projectId = session.project_id;
    entry.updatedAt = Math.max(entry.updatedAt, date);
    // A full-text archive hit must still reveal its canonical conversation, even if the title differs.
    archiveMatches.add(entry.id);
    keywords.set(
      entry.id,
      `${keywords.get(entry.id) ?? entry.title} ${session.title} ${session.agent}`,
    );
  }
  return entries
    .filter(
      (entry) =>
        projectScope === "all" ||
        (projectScope === "unassigned"
          ? entry.projectId === null
          : entry.projectId === projectScope),
    )
    .filter(
      (entry) => matches(keywords.get(entry.id) ?? entry.title) || archiveMatches.has(entry.id),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}
