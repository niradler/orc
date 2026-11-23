import { type ChatThread, nativeChatAgent } from "@orc/core/chat";
import {
  type ChatAnalytics,
  type ChatContextAnalytics,
  type ChatModelUsageStat,
  type ChatSkillStat,
  type ChatToolStat,
  type ChatTurnStat,
  type ChatTurnUsage,
  type ChatUsageSource,
  type ChatUsageSummary,
  EMPTY_CHAT_USAGE_SUMMARY,
} from "@orc/core/chat-analytics";
import { agentLabel, codingAgent } from "@orc/core/coding-agents";
import { loadConfig } from "@orc/core/config";
import { execHostFor, type HostRuntime, hostRuntime } from "@orc/core/exec-host";
import {
  estimateUsageCost,
  type ModelPricingMap,
  netCacheSavingsUsd,
  resolveModelPrice,
  roundUsd,
} from "@orc/core/usage";
import {
  emptySessionCacheUsage,
  emptySessionUsageDetail,
  loadSessionUsageDetail,
  type SessionRequestUsage,
  type SessionUsageDetail,
} from "./cache-usage.js";

const TURN_POINTS = 80;
const TOOL_ROWS = 50;
const WINDOW_GRACE_MS = 2_000;
const GENERIC_MODELS = new Set(["claude", "codex", "cursor", "gemini", "opencode", "pi"]);

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
const usageCache = new Map<string, SessionUsageDetail>();

function rememberUsage(key: string, value: SessionUsageDetail): SessionUsageDetail {
  if (usageCache.size >= USAGE_CACHE_ENTRIES) {
    const oldest = usageCache.keys().next().value;
    if (oldest !== undefined) usageCache.delete(oldest);
  }
  usageCache.set(key, value);
  return value;
}

async function cachedUsageDetail(
  runtime: CacheRuntime,
  backend: string,
  path: string,
  runtimeSessionId: string | null,
): Promise<SessionUsageDetail> {
  const info = backend === "opencode" ? null : await runtime.stat?.(path).catch(() => null);
  const key = info
    ? `${backend}\0${path}\0${runtimeSessionId ?? ""}\0${info.size}\0${info.mtimeMs}`
    : null;
  const cached = key ? usageCache.get(key) : undefined;
  if (cached) return cached;
  const value = await loadSessionUsageDetail(runtime, backend, path, runtimeSessionId);
  return key ? rememberUsage(key, value) : value;
}

export type ChatNativeSource = {
  backend: string;
  model: string | null;
  transcript_path: string | null;
  runtime_session_id: string | null;
  tokens_used?: number | null;
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

function emptyUsage(): ChatTurnUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
}

function addUsage(target: ChatTurnUsage, delta: ChatTurnUsage): void {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheRead += delta.cacheRead;
  target.cacheWrite += delta.cacheWrite;
  target.reasoning += delta.reasoning;
  target.total += delta.total;
}

function requestToUsage(request: SessionRequestUsage): ChatTurnUsage {
  return {
    input: request.input_tokens,
    output: request.output_tokens,
    cacheRead: request.cache_read_tokens,
    cacheWrite: request.cache_write_tokens,
    reasoning: request.reasoning_tokens,
    total: request.total_tokens,
  };
}

function cacheHitRateFor(usage: ChatTurnUsage, supported: boolean): number | null {
  if (!supported) return null;
  const totalInput = usage.input + usage.cacheRead + usage.cacheWrite;
  return totalInput > 0 ? usage.cacheRead / totalInput : null;
}

function effectiveModel(
  messageModel: string | null,
  requestModel: string | null,
  fallbackModel: string | null,
): string | null {
  if (requestModel && !GENERIC_MODELS.has(requestModel.toLowerCase())) {
    return requestModel;
  }
  return messageModel ?? fallbackModel ?? requestModel;
}

type TurnEntry = {
  index: number;
  startedAt: number;
  finishedAt: number | undefined;
  durationMs: number | null;
  messageTimestamp: number;
  outcome: ChatTurnStat["outcome"];
  toolCalls: number;
  toolFailures: number;
  responseChars: number;
  messageModel: string | null;
  frozenUsage: { input_tokens: number; cached_input_tokens: number } | undefined;
};

type TurnWindow = {
  windowStart: number;
  windowEnd: number;
};

function buildTurnWindows(turns: readonly TurnEntry[]): TurnWindow[] {
  const windows: TurnWindow[] = [];
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index] as TurnEntry;
    const next = turns[index + 1];
    const start = turn.startedAt;
    const rawEnd =
      turn.finishedAt ??
      (turn.durationMs !== null ? start + turn.durationMs : turn.messageTimestamp);
    const end = Math.max(start, rawEnd);
    const isRunning =
      turn.outcome === "running" || (turn.finishedAt === undefined && turn.durationMs === null);
    let windowEnd: number;
    if (next) {
      if (isRunning) {
        windowEnd = next.startedAt - 1;
      } else if (next.startedAt > end) {
        windowEnd = Math.min(end + WINDOW_GRACE_MS, Math.floor((end + next.startedAt) / 2));
      } else {
        windowEnd = Math.max(start, next.startedAt - 1);
      }
    } else {
      windowEnd = isRunning ? Number.POSITIVE_INFINITY : end + WINDOW_GRACE_MS;
    }
    const prevEnd =
      index > 0 ? (windows[index - 1] as TurnWindow).windowEnd : Number.NEGATIVE_INFINITY;
    const windowStart = Math.max(start - WINDOW_GRACE_MS, prevEnd + 1);
    windows.push({ windowStart, windowEnd });
  }
  return windows;
}

type ModelAccumulator = {
  model: string | null;
  turns: Set<number>;
  requests: number;
  usage: ChatTurnUsage;
  costUsd: number;
  hasUnpriced: boolean;
  rawCacheSavingsUsd: number;
  hasPricedSavings: boolean;
  estimated: boolean;
};

export type ChatAnalyticsOptions = {
  requests?: readonly SessionRequestUsage[];
  fallbackModel?: string | null;
  pricing?: ModelPricingMap | null;
  estimatedSessionTokens?: number | null;
  estimatedBackend?: boolean;
  cacheSupported?: boolean;
};

/**
 * Counts what the chat itself recorded: every coding agent produces these events,
 * even when its transcript cannot report token context.
 */
export function readChatAnalytics(
  thread: ChatThread,
  options: ChatAnalyticsOptions = {},
): Omit<ChatAnalytics, "context"> {
  const tools = new Map<string, ChatToolStat>();
  const skills = new Map<string, ChatSkillStat>();
  const turnEntries: TurnEntry[] = [];
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
    turnEntries.push({
      index: turnEntries.length + 1,
      startedAt: turn.startedAt,
      finishedAt: turn.finishedAt,
      durationMs: turn.durationMs ?? null,
      messageTimestamp: message.timestamp,
      outcome,
      toolCalls: messageTools,
      toolFailures: messageFailures,
      responseChars: message.content.length,
      messageModel: text(message.model),
      frozenUsage: turn.usage,
    });
  }

  const fallbackModel = text(options.fallbackModel) ?? text(thread.config.model);
  const pricing = options.pricing ?? null;
  const requests = options.requests ?? [];
  const cacheSupported = options.cacheSupported ?? !options.estimatedBackend;
  const windows = buildTurnWindows(turnEntries);
  const matchedByTurn: SessionRequestUsage[][] = turnEntries.map(() => []);
  const unattributedList: SessionRequestUsage[] = [];

  for (const request of requests) {
    if (request.ts === null) {
      unattributedList.push(request);
      continue;
    }
    let matchedIndex = -1;
    for (let index = 0; index < windows.length; index += 1) {
      const window = windows[index] as TurnWindow;
      if (request.ts >= window.windowStart && request.ts <= window.windowEnd) {
        matchedIndex = index;
        break;
      }
    }
    if (matchedIndex >= 0) {
      (matchedByTurn[matchedIndex] as SessionRequestUsage[]).push(request);
    } else {
      unattributedList.push(request);
    }
  }

  const modelBuckets = new Map<string, ModelAccumulator>();
  const addToModelBucket = (
    model: string | null,
    turnIndex: number | null,
    reqUsage: ChatTurnUsage,
    estimated: boolean,
  ): number | null => {
    const key = model ?? "";
    let bucket = modelBuckets.get(key);
    if (!bucket) {
      bucket = {
        model,
        turns: new Set(),
        requests: 0,
        usage: emptyUsage(),
        costUsd: 0,
        hasUnpriced: false,
        rawCacheSavingsUsd: 0,
        hasPricedSavings: false,
        estimated: false,
      };
      modelBuckets.set(key, bucket);
    }
    if (turnIndex !== null) bucket.turns.add(turnIndex);
    bucket.requests += 1;
    addUsage(bucket.usage, reqUsage);
    bucket.estimated ||= estimated;

    const price = resolveModelPrice(model, pricing, { includeDefaults: !estimated });
    if (!price) {
      bucket.hasUnpriced = true;
      return null;
    }
    const cost = estimateUsageCost(reqUsage, price);
    bucket.costUsd = roundUsd(bucket.costUsd + cost);
    bucket.rawCacheSavingsUsd += netCacheSavingsUsd(reqUsage, price);
    bucket.hasPricedSavings = true;
    return cost;
  };

  const attributedTotal = emptyUsage();
  let attributedCount = 0;

  const turnStats: ChatTurnStat[] = turnEntries.map((entry, index) => {
    const matched = matchedByTurn[index] as SessionRequestUsage[];
    let turnModel = entry.messageModel;
    if (matched.length > 0) {
      const turnUsage = emptyUsage();
      let turnCost = 0;
      let allPriced = true;
      let anyEstimated = Boolean(options.estimatedBackend);
      for (const req of matched) {
        const reqUsage = requestToUsage(req);
        addUsage(turnUsage, reqUsage);
        const resolvedModel = effectiveModel(entry.messageModel, req.model, fallbackModel);
        if (resolvedModel) turnModel = resolvedModel;
        const estimated = req.estimated || Boolean(options.estimatedBackend);
        anyEstimated ||= estimated;
        const cost = addToModelBucket(resolvedModel, entry.index, reqUsage, estimated);
        if (cost === null) allPriced = false;
        else turnCost = roundUsd(turnCost + cost);
      }
      addUsage(attributedTotal, turnUsage);
      attributedCount += 1;
      const usageSource: ChatUsageSource = anyEstimated ? "estimated" : "recorded";
      return {
        index: entry.index,
        startedAt: entry.startedAt,
        durationMs: entry.durationMs,
        outcome: entry.outcome,
        toolCalls: entry.toolCalls,
        toolFailures: entry.toolFailures,
        responseChars: entry.responseChars,
        model: turnModel ?? fallbackModel,
        usage: turnUsage,
        costUsd: allPriced ? turnCost : null,
        usageSource,
      };
    }

    if (options.estimatedBackend && entry.frozenUsage && entry.frozenUsage.input_tokens > 0) {
      const cached = Math.min(
        entry.frozenUsage.input_tokens,
        entry.frozenUsage.cached_input_tokens,
      );
      const fresh = Math.max(0, entry.frozenUsage.input_tokens - cached);
      const turnUsage: ChatTurnUsage = {
        input: fresh,
        output: 0,
        cacheRead: cached,
        cacheWrite: 0,
        reasoning: 0,
        total: entry.frozenUsage.input_tokens,
      };
      const resolvedModel = entry.messageModel ?? fallbackModel;
      const cost = addToModelBucket(resolvedModel, entry.index, turnUsage, true);
      addUsage(attributedTotal, turnUsage);
      attributedCount += 1;
      return {
        index: entry.index,
        startedAt: entry.startedAt,
        durationMs: entry.durationMs,
        outcome: entry.outcome,
        toolCalls: entry.toolCalls,
        toolFailures: entry.toolFailures,
        responseChars: entry.responseChars,
        model: resolvedModel,
        usage: turnUsage,
        costUsd: cost,
        usageSource: "estimated",
      };
    }

    return {
      index: entry.index,
      startedAt: entry.startedAt,
      durationMs: entry.durationMs,
      outcome: entry.outcome,
      toolCalls: entry.toolCalls,
      toolFailures: entry.toolFailures,
      responseChars: entry.responseChars,
      model: entry.messageModel,
      usage: null,
      costUsd: null,
      usageSource: "unreadable",
    };
  });

  const unattributedTotal = emptyUsage();
  let unattributedRequests = 0;

  for (const req of unattributedList) {
    const reqUsage = requestToUsage(req);
    const resolvedModel = effectiveModel(null, req.model, fallbackModel);
    const estimated = req.estimated || Boolean(options.estimatedBackend);
    addToModelBucket(resolvedModel, null, reqUsage, estimated);
    addUsage(unattributedTotal, reqUsage);
    unattributedRequests += 1;
  }

  const estimatedTokens =
    options.estimatedSessionTokens && Number.isFinite(options.estimatedSessionTokens)
      ? Math.max(0, Math.round(options.estimatedSessionTokens))
      : 0;
  if (
    options.estimatedBackend &&
    requests.length === 0 &&
    estimatedTokens > attributedTotal.total
  ) {
    const remainder = estimatedTokens - attributedTotal.total;
    const reqUsage: ChatTurnUsage = {
      input: remainder,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: remainder,
    };
    addToModelBucket(fallbackModel, null, reqUsage, true);
    addUsage(unattributedTotal, reqUsage);
    unattributedRequests += 1;
  }

  let usageSummary: ChatUsageSummary = EMPTY_CHAT_USAGE_SUMMARY;
  if (attributedCount > 0 || unattributedRequests > 0) {
    const attributed = attributedCount > 0 ? attributedTotal : null;
    const unattributed = unattributedRequests > 0 ? unattributedTotal : null;
    const totals = emptyUsage();
    if (attributed) addUsage(totals, attributed);
    if (unattributed) addUsage(totals, unattributed);

    const byModel: ChatModelUsageStat[] = [...modelBuckets.values()]
      .sort(
        (left, right) =>
          right.usage.total - left.usage.total ||
          (left.model ?? "").localeCompare(right.model ?? ""),
      )
      .map((bucket) => ({
        model: bucket.model,
        turns: bucket.turns.size,
        requests: bucket.requests,
        usage: bucket.usage,
        costUsd: bucket.hasUnpriced ? null : bucket.costUsd,
        cacheHitRate: cacheHitRateFor(bucket.usage, cacheSupported),
        cacheSavingsUsd:
          !bucket.hasUnpriced && bucket.hasPricedSavings
            ? roundUsd(Math.max(0, bucket.rawCacheSavingsUsd))
            : null,
        usageSource: bucket.estimated ? "estimated" : "recorded",
      }));

    const pricedModels = byModel.filter((row) => row.costUsd !== null);
    const costComplete = byModel.length > 0 && pricedModels.length === byModel.length;
    const totalCostUsd =
      pricedModels.length > 0
        ? roundUsd(pricedModels.reduce((sum, row) => sum + (row.costUsd ?? 0), 0))
        : null;
    const savingsModels = byModel.filter((row) => row.cacheSavingsUsd !== null);
    const cacheSavingsUsd =
      savingsModels.length > 0
        ? roundUsd(savingsModels.reduce((sum, row) => sum + (row.cacheSavingsUsd ?? 0), 0))
        : null;
    const usageSource: ChatUsageSource = byModel.some((row) => row.usageSource === "estimated")
      ? "estimated"
      : "recorded";

    usageSummary = {
      totals,
      attributed,
      unattributed,
      unattributedRequests,
      cacheHitRate: cacheHitRateFor(totals, cacheSupported),
      cacheSavingsUsd,
      totalCostUsd,
      costComplete,
      usageSource,
      byModel,
    };
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
    usage: usageSummary,
  };
}

function percentile(sorted: readonly number[], ratio: number): number | null {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index] ?? null;
}

async function readChatContextWithDetail(
  runtime: CacheRuntime,
  thread: ChatThread,
  source: ChatNativeSource | null,
): Promise<{ context: ChatContextAnalytics | null; detail: SessionUsageDetail }> {
  if (!thread.runtimeId) return { context: null, detail: emptySessionUsageDetail() };
  const model = source?.model || thread.config.model || null;
  if (!source) {
    const discoverable =
      nativeChatAgent(thread.config.agent) !== null &&
      (codingAgent(thread.config.agent)?.sessionBackends.length ?? 0) > 0;
    return {
      context: unsupported(
        thread.backend,
        model,
        discoverable
          ? "ORC has not discovered this agent session yet. Context usage appears after the session is indexed."
          : `ORC cannot read ${agentLabel(thread.config.agent)} sessions for this chat, so context and cache usage are unavailable.`,
      ),
      detail: emptySessionUsageDetail(),
    };
  }
  const reason = UNSUPPORTED_CONTEXT[source.backend];
  if (reason)
    return {
      context: unsupported(source.backend, model, reason),
      detail: emptySessionUsageDetail(),
    };
  if (!source.transcript_path)
    return {
      context: unsupported(
        source.backend,
        model,
        "This agent session has no readable transcript on its execution host.",
      ),
      detail: emptySessionUsageDetail(),
    };
  try {
    const detail = await cachedUsageDetail(
      runtime,
      source.backend,
      source.transcript_path,
      source.runtime_session_id,
    );
    return {
      context: {
        backend: source.backend,
        model,
        supported: true,
        reason: null,
        usage: detail.cache,
      },
      detail,
    };
  } catch {
    return {
      context: unsupported(
        source.backend,
        model,
        "Context usage could not be read from the agent transcript.",
      ),
      detail: emptySessionUsageDetail(),
    };
  }
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
  return (await readChatContextWithDetail(runtime, thread, source)).context;
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

const ESTIMATED_BACKENDS = new Set(["cursor", "cursor-agent", "gemini"]);

/** The full analytics payload for one chat, shared by the chat route and the
 *  session page so both surfaces report the same numbers. */
export async function chatAnalyticsFor(
  thread: ChatThread,
  source: ChatNativeSource | null,
  runtime: CacheRuntime = hostRuntime(execHostFor(thread.host)),
  pricingOverrides?: ModelPricingMap | null,
): Promise<ChatAnalytics> {
  const { context, detail } = await readChatContextWithDetail(runtime, thread, source);
  const backend = source?.backend ?? thread.backend;
  const estimatedBackend = ESTIMATED_BACKENDS.has(backend);
  const pricing = pricingOverrides ?? loadConfig().preferences.model_pricing ?? null;
  const analytics = readChatAnalytics(thread, {
    requests: detail.requests,
    fallbackModel: source?.model || thread.config.model || null,
    pricing,
    estimatedSessionTokens: source?.tokens_used ?? null,
    estimatedBackend,
    cacheSupported: context?.supported ?? !estimatedBackend,
  });
  return { ...analytics, context };
}
