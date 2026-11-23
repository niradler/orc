import { type ChatThread, nativeChatAgent } from "@orc/core/chat";
import type {
  ChatAnalytics,
  ChatContextAnalytics,
  ChatSkillStat,
  ChatToolStat,
  ChatTurnStat,
} from "@orc/core/chat-analytics";
import { agentLabel, codingAgent } from "@orc/core/coding-agents";
import { execHostFor, type HostRuntime, hostRuntime } from "@orc/core/exec-host";
import type { SessionCacheUsage } from "@orc/core/usage";
import { emptySessionCacheUsage, loadSessionCacheUsage } from "./cache-usage.js";

const TURN_POINTS = 80;
const TOOL_ROWS = 50;

const UNSUPPORTED_CONTEXT: Record<string, string> = {
  cursor:
    "Cursor does not record prompt context or cache reuse in a transcript ORC can read for this chat.",
  "cursor-agent":
    "Cursor does not record prompt context or cache reuse in a transcript ORC can read for this chat.",
  gemini:
    "Gemini CLI records a per-message token total but not prompt context or cache reuse for this chat.",
};

type CacheRuntime = Pick<HostRuntime, "isFile" | "readFile"> &
  Partial<Pick<HostRuntime, "sqliteQuery" | "stat">>;

const USAGE_CACHE_ENTRIES = 64;
/** Keyed by the transcript's own size and mtime, so an append or rewrite is a
 *  miss. Polling tabs therefore stop re-parsing the whole file every 15 s. */
const usageCache = new Map<string, SessionCacheUsage>();

function rememberUsage(key: string, value: SessionCacheUsage): SessionCacheUsage {
  if (usageCache.size >= USAGE_CACHE_ENTRIES) {
    const oldest = usageCache.keys().next().value;
    if (oldest !== undefined) usageCache.delete(oldest);
  }
  usageCache.set(key, value);
  return value;
}

async function cachedUsage(
  runtime: CacheRuntime,
  backend: string,
  path: string,
  runtimeSessionId: string | null,
): Promise<SessionCacheUsage> {
  // OpenCode answers from its own indexed database, so there is nothing to cache.
  const info = backend === "opencode" ? null : await runtime.stat?.(path).catch(() => null);
  const key = info
    ? `${backend}\0${path}\0${runtimeSessionId ?? ""}\0${info.size}\0${info.mtimeMs}`
    : null;
  const cached = key ? usageCache.get(key) : undefined;
  if (cached) return cached;
  const value = await loadSessionCacheUsage(runtime, backend, path, runtimeSessionId);
  return key ? rememberUsage(key, value) : value;
}

type ChatNativeSource = {
  backend: string;
  model: string | null;
  transcript_path: string | null;
  runtime_session_id: string | null;
};

const SKILL_FILE = /\bskills\/([\w.:-]+)\/SKILL\.md\b/;
const SKILL_FILE_READ =
  /\b(?:cat|head|tail|less|bat|sed)\b[^|;&\n]*?\bskills\/([\w.:-]+)\/SKILL\.md\b/;

function parsed(input: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(input);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function skillLoaded(name: string, input: string): string | null {
  const args = parsed(input);
  if (name === "Skill") return text(args.skill);
  if (name === "skill_read" || name.endsWith("__skill_read")) return text(args.name);
  if (name === "tool_invoke" || name.endsWith("__tool_invoke")) {
    const call = args.arguments && typeof args.arguments === "object" ? args.arguments : {};
    return args.name === "skill_read" ? text((call as Record<string, unknown>).name) : null;
  }
  if (name === "Read") return SKILL_FILE.exec(text(args.file_path) ?? "")?.[1] ?? null;
  if (/\bsed\s+(?:-[a-zA-Z]*\s+)*-i|>\s*\S*SKILL\.md/.test(input)) return null;
  return SKILL_FILE_READ.exec(input)?.[1] ?? null;
}

/**
 * Counts what the chat itself recorded: every coding agent produces these events,
 * even when its transcript cannot report token context.
 */
export function readChatAnalytics(thread: ChatThread): Omit<ChatAnalytics, "context"> {
  const tools = new Map<string, ChatToolStat>();
  const skills = new Map<string, ChatSkillStat>();
  const turnStats: ChatTurnStat[] = [];
  const durations: number[] = [];
  const outcomes = { completed: 0, stopped: 0, interrupted: 0, failed: 0, running: 0 };
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolFailures = 0;
  let attachments = 0;

  for (const message of thread.messages) {
    if (message.role === "user") userMessages += 1;
    else assistantMessages += 1;
    attachments += message.attachments?.length ?? 0;

    let messageTools = 0;
    let messageFailures = 0;
    for (const activity of message.activity ?? []) {
      if (activity.type !== "tool") continue;
      messageTools += 1;
      toolCalls += 1;
      const failed = activity.isError === true;
      if (failed) {
        messageFailures += 1;
        toolFailures += 1;
      }
      const stat = tools.get(activity.name) ?? { name: activity.name, calls: 0, failures: 0 };
      stat.calls += 1;
      if (failed) stat.failures += 1;
      tools.set(activity.name, stat);
      const skill = skillLoaded(activity.name, activity.input);
      if (skill) {
        const loaded = skills.get(skill) ?? { name: skill, loads: 0 };
        loaded.loads += 1;
        skills.set(skill, loaded);
      }
    }

    const turn = message.turn;
    if (!turn) continue;
    const outcome = turn.outcome ?? "running";
    outcomes[outcome] += 1;
    if (turn.durationMs !== undefined) durations.push(turn.durationMs);
    turnStats.push({
      index: turnStats.length + 1,
      startedAt: turn.startedAt,
      durationMs: turn.durationMs ?? null,
      outcome,
      toolCalls: messageTools,
      toolFailures: messageFailures,
      responseChars: message.content.length,
    });
  }

  durations.sort((left, right) => left - right);
  const turnTimeline = turnStats.slice(-TURN_POINTS);
  return {
    messages: thread.messages.length,
    userMessages,
    assistantMessages,
    turns: turnStats.length,
    toolCalls,
    toolFailures,
    attachments,
    startedAt: thread.messages[0]?.timestamp ?? null,
    lastActivityAt: thread.messages.at(-1)?.timestamp ?? null,
    outcomes,
    durations: {
      averageMs: durations.length
        ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
        : null,
      medianMs: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      totalMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) : null,
    },
    tools: [...tools.values()]
      .sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name))
      .slice(0, TOOL_ROWS),
    toolTotal: tools.size,
    skills: [...skills.values()].sort(
      (left, right) => right.loads - left.loads || left.name.localeCompare(right.name),
    ),
    turnTimeline,
    turnTimelineTruncated: turnStats.length > turnTimeline.length,
  };
}

function percentile(sorted: readonly number[], ratio: number): number | null {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index] ?? null;
}

/**
 * Context and cache figures come from the agent's own session, because only the
 * agent sees every request. Unsupported or unreadable sources degrade to an
 * explanation instead of blocking the chat-derived analytics.
 */
export async function readChatContext(
  runtime: CacheRuntime,
  thread: ChatThread,
  source: ChatNativeSource | null,
): Promise<ChatContextAnalytics | null> {
  if (!thread.runtimeId) return null;
  const model = source?.model || thread.config.model || null;
  if (!source) {
    // Only agents with a discoverable session store can ever appear here; the
    // others would wait for an index that never happens.
    const discoverable =
      nativeChatAgent(thread.config.agent) !== null &&
      (codingAgent(thread.config.agent)?.sessionBackends.length ?? 0) > 0;
    return unsupported(
      thread.backend,
      model,
      discoverable
        ? "ORC has not discovered this agent session yet. Context usage appears after the session is indexed."
        : `ORC cannot read ${agentLabel(thread.config.agent)} sessions for this chat, so context and cache usage are unavailable.`,
    );
  }
  const reason = UNSUPPORTED_CONTEXT[source.backend];
  if (reason) return unsupported(source.backend, model, reason);
  if (!source.transcript_path)
    return unsupported(
      source.backend,
      model,
      "This agent session has no readable transcript on its execution host.",
    );
  try {
    return {
      backend: source.backend,
      model,
      supported: true,
      reason: null,
      usage: await cachedUsage(
        runtime,
        source.backend,
        source.transcript_path,
        source.runtime_session_id,
      ),
    };
  } catch {
    return unsupported(
      source.backend,
      model,
      "Context usage could not be read from the agent transcript.",
    );
  }
}

function unsupported(backend: string, model: string | null, reason: string): ChatContextAnalytics {
  return {
    backend,
    model,
    supported: false,
    reason,
    usage: emptySessionCacheUsage(),
  };
}

/** The full analytics payload for one chat, shared by the chat route and the
 *  session page so both surfaces report the same numbers. */
export async function chatAnalyticsFor(
  thread: ChatThread,
  source: ChatNativeSource | null,
  runtime = hostRuntime(execHostFor(thread.host)),
): Promise<ChatAnalytics> {
  const context = await readChatContext(runtime, thread, source);
  return { ...readChatAnalytics(thread), context };
}
