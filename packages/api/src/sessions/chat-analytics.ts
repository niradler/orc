import type { ChatThread } from "@orc/core/chat";
import type {
  ChatAnalytics,
  ChatContextAnalytics,
  ChatToolStat,
  ChatTurnStat,
} from "@orc/core/chat-analytics";
import type { HostRuntime } from "@orc/core/exec-host";
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
  Partial<Pick<HostRuntime, "sqliteQuery">>;

export type ChatNativeSource = {
  backend: string;
  model: string | null;
  transcript_path: string | null;
  runtime_session_id: string | null;
};

/**
 * Counts what the chat itself recorded: every coding agent produces these events,
 * even when its transcript cannot report token context.
 */
export function readChatAnalytics(thread: ChatThread): Omit<ChatAnalytics, "context"> {
  const tools = new Map<string, ChatToolStat>();
  const turnStats: ChatTurnStat[] = [];
  const durations: number[] = [];
  const outcomes = { completed: 0, stopped: 0, failed: 0, running: 0 };
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
  if (!source)
    return unsupported(
      thread.backend,
      model,
      "ORC has not discovered this agent session yet. Context usage appears after the session is indexed.",
    );
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
      usage: await loadSessionCacheUsage(
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
