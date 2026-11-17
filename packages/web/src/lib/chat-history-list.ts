import type { ChatThread } from "@orc/core/chat";
import { projectForFolder } from "@orc/core/project-path";
import type { ArchiveSession } from "@orc/core/session-archive";
import type { LiveSession, Terminal } from "@/api/client";
import type { ChatTab } from "@/hooks/useChat";
import { type AgentState, liveSessionState, moreUrgent, rollupState } from "./agent-state";
import { modelDisplayName, PERMISSION_LABELS } from "./composer-chips";
import { lastSeen, type SeenRecord, unseenState } from "./session-seen";

type SavedChat = Pick<ChatThread, "id" | "title" | "updatedAt"> & {
  running: boolean;
  agent?: string | null;
  runtimeId?: string | null;
  sourceId?: string | null;
  host?: string | null;
  projectId?: string | null;
  spawnedFrom?: string | null;
};
type HistorySource =
  | { kind: "local"; tab: ChatTab }
  | { kind: "saved"; thread: SavedChat }
  | { kind: "native"; session: LiveSession }
  | { kind: "archive"; session: ArchiveSession }
  | { kind: "terminal"; terminal: Terminal };
export type ChatHistoryEntry = HistorySource & {
  id: string;
  title: string;
  updatedAt: number;
  observedState?: AgentState;
  provider?: string;
  projectId?: string | null;
  terminalId?: string;
  seenKeys: string[];
  snippets?: string[];
  matched?: string[];
  children?: ChatHistoryEntry[];
  spawned?: boolean;
  subagents?: number;
};

export function withDescendants(entry: ChatHistoryEntry): ChatHistoryEntry[] {
  return [entry, ...(entry.children ?? []).flatMap(withDescendants)];
}

const SESSION_MODE_LABELS: Record<string, string> = {
  ...PERMISSION_LABELS,
  default: "Ask first",
  plan: "Plan",
  auto: "Auto",
  "danger-full-access": "Full access",
  "workspace-write": "Workspace write",
  "read-only": "Read only",
};

export function sessionRunLabel(entry: ChatHistoryEntry): string {
  if (entry.kind !== "native") return "";
  const { model, permission_mode: mode } = entry.session;
  const scope = mode?.split("/").pop();
  return [model && modelDisplayName(model), mode && ((scope && SESSION_MODE_LABELS[scope]) ?? mode)]
    .filter(Boolean)
    .join(" · ");
}

export function nestedLabel(children: readonly ChatHistoryEntry[]): string {
  const sessions = children.filter((child) => child.spawned).length;
  const subagents = children.length - sessions;
  return [
    subagents ? `${subagents} ${subagents === 1 ? "subagent" : "subagents"}` : "",
    sessions ? `${sessions} ${sessions === 1 ? "session" : "sessions"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function observe(entry: ChatHistoryEntry, state: AgentState) {
  entry.observedState = entry.observedState ? moreUrgent(entry.observedState, state) : state;
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
  terminals: readonly Terminal[] = [],
  includeShells = false,
  projectFolders: readonly { id: string; scope?: string | null }[] = [],
): ChatHistoryEntry[] {
  const matches = (text: string) => text.toLowerCase().includes(query.trim().toLowerCase());
  const entries: ChatHistoryEntry[] = [];
  const keywords = new Map<string, string>();
  const identities = new Map<string, ChatHistoryEntry>();
  const sources = new Map<string, ChatHistoryEntry>();
  const archiveMatches = new Set<string>();
  const contentMatches = new Set<string>();
  const liveEntries = new Map<string, ChatHistoryEntry>();
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
    const id = tab.thread ? `chat:${tab.thread.id}` : `draft:${tab.key}`;
    const entry: ChatHistoryEntry = {
      kind: "local",
      tab,
      projectId: tab.projectId,
      id,
      seenKeys: [id],
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
    const key =
      thread.agent && thread.runtimeId
        ? nativeKey(thread.agent, thread.runtimeId, thread.host)
        : null;
    if (chatIds.has(thread.id)) {
      const entry = entries.find((entry) => entry.id === `chat:${thread.id}`);
      if (!entry) continue;
      if (thread.running) observe(entry, "working");
      if (thread.title) entry.title = thread.title;
      keywords.set(entry.id, `${keywords.get(entry.id) ?? ""} ${thread.title}`);
      if (thread.sourceId && !sources.has(thread.sourceId)) sources.set(thread.sourceId, entry);
      if (key && !identities.has(key)) identities.set(key, entry);
      continue;
    }
    const existing =
      (thread.sourceId ? sources.get(thread.sourceId) : undefined) ||
      (key ? identities.get(key) : undefined);
    if (existing) {
      if (thread.running) observe(existing, "working");
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
      seenKeys: [`chat:${thread.id}`],
      title: thread.title,
      updatedAt: timestamp(thread.updatedAt),
      observedState: thread.running ? "working" : "idle",
      projectId: thread.projectId,
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
    const key = session.session_id
      ? nativeKey(session.agent, session.session_id, session.host)
      : null;
    const existing = sources.get(session.id) || (key ? identities.get(key) : undefined);
    const date = timestamp(session.last_activity_at || session.created_at);
    const entry: ChatHistoryEntry = existing ?? {
      kind: "native",
      session,
      id: `native:${session.id}`,
      seenKeys: [`native:${session.id}`],
      title: session.name || session.session_id || "Session",
      updatedAt: date,
    };
    if (!existing) entries.push(entry);
    else existing.seenKeys.push(`native:${session.id}`);
    entry.provider ??= session.agent;
    entry.projectId =
      entry.projectId ??
      session.project_id ??
      projectForFolder(session.cwd, projectFolders)?.id ??
      session.project_id;
    const hit = session as LiveSession & { snippets?: string[]; matched?: string[] };
    if (hit.snippets?.length) entry.snippets = hit.snippets;
    if (hit.matched?.length) entry.matched = hit.matched;
    if (hit.matched?.length) contentMatches.add(entry.id);
    observe(entry, liveSessionState(session));
    entry.updatedAt = Math.max(entry.updatedAt, date);
    keywords.set(
      entry.id,
      `${keywords.get(entry.id) ?? entry.title} ${session.name ?? ""} ${session.agent} ${session.cwd ?? ""}`,
    );
    if (key) identities.set(key, entry);
    liveEntries.set(session.id, entry);
  }
  const nested = new Set<ChatHistoryEntry>();
  const parentOf = new Map<ChatHistoryEntry, ChatHistoryEntry>();
  const chatEntries = new Map(entries.map((entry) => [entry.id, entry]));
  const spawnParent = (id: string | null | undefined) =>
    id ? (liveEntries.get(id) ?? chatEntries.get(`chat:${id}`)) : undefined;
  const nest = (child: ChatHistoryEntry | undefined, parent: ChatHistoryEntry | undefined) => {
    if (!child || !parent || nested.has(child)) return false;
    for (let at: ChatHistoryEntry | undefined = parent; at; at = parentOf.get(at))
      if (at === child) return false;
    parent.children = [...(parent.children ?? []), child];
    parentOf.set(child, parent);
    nested.add(child);
    return true;
  };
  for (const session of native) {
    const parent = session.parent_id ? liveEntries.get(session.parent_id) : undefined;
    nest(liveEntries.get(session.id), parent);
  }
  const nestSpawn = (child: ChatHistoryEntry | undefined, from: string | null | undefined) => {
    if (child && nest(child, spawnParent(from))) child.spawned = true;
  };
  for (const session of native) nestSpawn(liveEntries.get(session.id), session.spawned_from_id);
  for (const entry of entries)
    nestSpawn(
      entry,
      entry.kind === "local"
        ? entry.tab.thread?.spawnedBy?.sessionId
        : entry.kind === "saved"
          ? entry.thread.spawnedFrom
          : undefined,
    );
  const rollup = (entry: ChatHistoryEntry) => {
    if (!entry.children) return;
    for (const child of entry.children) rollup(child);
    entry.children.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const busy = rollupState(entry.children.map((child) => child.observedState));
    if (busy) observe(entry, busy);
    entry.updatedAt = Math.max(entry.updatedAt, ...entry.children.map((child) => child.updatedAt));
    entry.seenKeys.push(...entry.children.flatMap((child) => child.seenKeys));
  };
  for (const entry of entries) if (!nested.has(entry)) rollup(entry);
  for (const terminal of terminals) {
    if (terminal.status !== "running" || (terminal.kind === "shell" && !includeShells)) continue;
    const linked = terminal.live_session_id ? liveEntries.get(terminal.live_session_id) : undefined;
    if (linked) {
      if (linked.kind === "native") linked.terminalId ??= terminal.id;
      continue;
    }
    const entry: ChatHistoryEntry = {
      kind: "terminal",
      terminal,
      terminalId: terminal.id,
      id: `terminal:${terminal.id}`,
      seenKeys: [`terminal:${terminal.id}`],
      title: terminal.name,
      provider: terminal.kind,
      updatedAt: timestamp(terminal.created_at),
    };
    entries.push(entry);
    keywords.set(entry.id, `${terminal.name} ${terminal.kind} ${terminal.cwd ?? ""}`);
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
      seenKeys: [`archive:${session.id}`],
      title: session.title || session.native_id,
      updatedAt: date,
    };
    if (!existing) entries.push(entry);
    entry.provider ??= session.agent;
    if (entry.projectId === undefined) entry.projectId = session.project_id;
    entry.updatedAt = Math.max(entry.updatedAt, date);
    const hit = session as ArchiveSession & { passages?: { snippet: string }[] };
    if (hit.passages?.length) entry.snippets = hit.passages.map((passage) => passage.snippet);
    // A full-text archive hit must still reveal its canonical conversation, even if the title differs.
    archiveMatches.add(entry.id);
    keywords.set(
      entry.id,
      `${keywords.get(entry.id) ?? entry.title} ${session.title} ${session.agent}`,
    );
  }
  for (const entry of entries) {
    if (entry.projectId) continue;
    entry.projectId = projectForFolder(entryCwd(entry), projectFolders)?.id ?? entry.projectId;
  }
  for (const entry of entries)
    if (entry.children?.length && !nested.has(entry))
      keywords.set(
        entry.id,
        withDescendants(entry)
          .map((item) => keywords.get(item.id) ?? item.title)
          .join(" "),
      );
  const keepSpawned = (entry: ChatHistoryEntry) => {
    if (!entry.children) return;
    const subagents = entry.children.filter((child) => !child.spawned).length;
    if (subagents) entry.subagents = subagents;
    entry.children = entry.children.filter((child) => child.spawned);
    for (const child of entry.children) keepSpawned(child);
    if (!entry.children.length) delete entry.children;
  };
  for (const entry of entries) if (!nested.has(entry)) keepSpawned(entry);
  return entries
    .filter((entry) => !nested.has(entry))
    .filter(
      (entry) =>
        projectScope === "all" ||
        (projectScope === "unassigned"
          ? entry.projectId === null
          : entry.projectId === projectScope),
    )
    .filter(
      (entry) =>
        [entry, ...(entry.children ?? [])].some(
          (item) => archiveMatches.has(item.id) || contentMatches.has(item.id),
        ) || matches(keywords.get(entry.id) ?? entry.title),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

/** The row's provider: the live agent for discovered sessions, the tab or thread agent otherwise. */
export function entryAgent(entry: ChatHistoryEntry): string {
  if (entry.kind === "local") return entry.tab.config.agent;
  if (entry.kind === "saved") return entry.thread.agent || entry.provider || "";
  if (entry.kind === "terminal") return entry.terminal.kind;
  return entry.session.agent;
}

/** The row's state; finished activity this client has not seen reads Done until opened. */
export function historyEntryState(
  entry: ChatHistoryEntry,
  seen: SeenRecord,
  selected = false,
): AgentState {
  const tab = entry.kind === "local" ? entry.tab : null;
  const own: AgentState = tab
    ? tab.permissions.length || tab.questions.length
      ? "needs-you"
      : tab.error
        ? "failed"
        : tab.streaming
          ? "working"
          : tab.attention
            ? "done"
            : "idle"
    : entry.kind === "saved"
      ? entry.thread.running
        ? "working"
        : "idle"
      : entry.kind === "native"
        ? liveSessionState(entry.session)
        : entry.kind === "terminal"
          ? "unknown"
          : "ended";
  const state = entry.observedState ? moreUrgent(own, entry.observedState) : own;
  if (selected || entry.kind === "terminal" || entry.id.startsWith("draft:")) return state;
  return unseenState(state, entry.updatedAt, lastSeen(seen, entry.seenKeys));
}

export function entryCwd(entry: ChatHistoryEntry): string | null {
  const cwd =
    entry.kind === "local"
      ? (entry.tab.thread?.cwd ?? entry.tab.workspace?.cwd)
      : entry.kind === "native"
        ? entry.session.cwd
        : entry.kind === "terminal"
          ? entry.terminal.cwd
          : null;
  return cwd?.trim() || null;
}

export function folderProjectName(cwd: string, taken: string[]): string {
  const used = new Set(taken.map((name) => name.toLowerCase()));
  const slug = (value: string) =>
    value
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 90) || "project";
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  const base = slug(parts[parts.length - 1] ?? "");
  const candidates = [base, slug(parts.slice(-2).join("-"))];
  for (let n = 2; n < 100; n++) candidates.push(`${base}-${n}`);
  return candidates.find((name) => !used.has(name.toLowerCase())) ?? `${base}-${Date.now()}`;
}

export function folderLabel(
  cwd: string | null,
  folders: readonly (string | null)[],
  projects: readonly string[] = [],
): string {
  if (!cwd) return "Unassigned";
  const parts = (path: string) => path.split(/[\\/]/).filter(Boolean);
  const own = parts(cwd);
  const others = folders.flatMap((other) => (other && other !== cwd ? [parts(other)] : []));
  const taken = new Set(projects.map((name) => name.toLowerCase()));
  for (let depth = 1; depth <= own.length; depth++) {
    const tail = own.slice(-depth).join("/");
    if (taken.has(tail.toLowerCase())) continue;
    if (!others.some((other) => other.slice(-depth).join("/") === tail)) return tail;
  }
  return cwd;
}
