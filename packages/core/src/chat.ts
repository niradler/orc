import { z } from "zod";
import { ChatAgentOptionsMapSchema, ChatPermissionModeSchema } from "./chat-options.js";
import { chatUiCatalogText } from "./chat-ui.js";
import { SecretRefsMapSchema } from "./project-secrets.js";
import { SessionFileSchema } from "./session-file-types.js";
import { SessionDeliverySchema } from "./session-messages.js";
import { AgentCapabilitiesSchema } from "./types.js";

export const NATIVE_CHAT_AGENTS = ["claude", "codex", "gemini", "opencode", "pi"];

export function nativeChatAgent(agent: string): string | null {
  return NATIVE_CHAT_AGENTS.includes(agent) ? agent : null;
}

export function nativeChatResumeUnavailableReason(agent: string): string | null {
  if (agent === "cursor-agent")
    return "Cursor CLI and ACP chat use separate session stores. Use Terminal to resume this conversation.";
  return nativeChatAgent(agent)
    ? null
    : "This session provider cannot resume in chat. Use Terminal when available.";
}

export { ChatPermissionModeSchema } from "./chat-options.js";

export const ORC_TASK_GUIDANCE = `When real task work is needed, discover and read relevant built-in ORC skills using skill_list and skill_read: orc-sdlc for engineering work and orc-platform for ORC operations. Load a skill's supporting files only when its instructions call for them, with skill_read and ref set to the file path if available, otherwise from the local skill folder. For nontrivial work, get the selected project's context first and follow the current skill guidance. Discover relevant tools as needed. Answer simple conversation directly.`;

export const CHAT_SYSTEM_PROMPT = `You are the ORC platform chat assistant.

${ORC_TASK_GUIDANCE}
Share relevant ORC links: session pages for reading, supported chat or terminal actions for resuming. Follow the session guidance.
Use scratchpads to collaborate on plans, diagrams, and HTML artifacts; share their links and preserve human edits.
Manage longer work through ORC tasks, progress updates, and handoffs.`;
/** Kept out of the editable prompt so custom prompts still get it, with the lean UI catalog. */
export const ORC_CHAT_CONTEXT_GUIDANCE = `Turns may start with ORC's hidden <orc-context> block (source, dashboard route or channel sender); use it without quoting it. Default to Markdown for ordinary answers and static status summaries. Only in webchat, when live monitoring, direct interaction or a saved scratchpad artifact adds value, use the smallest useful component reply from the catalog below.`;

/** Channel turns render Markdown only, so the UI catalog is added for webchat threads alone. */
export function chatSystemPrompt(system = CHAT_SYSTEM_PROMPT, { webchat = false } = {}): string {
  return [
    system,
    ORC_TASK_GUIDANCE,
    ORC_CHAT_CONTEXT_GUIDANCE,
    ...(webchat ? [chatUiCatalogText("lean")] : []),
  ]
    .filter((part, index) => index === 0 || !system.includes(part))
    .join("\n\n");
}

export const ChatModelSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^$|^[a-z0-9][a-z0-9._:/@+-]*(\[[a-z0-9]+\])?$/i);
export const ChatQuestionSchema = z.object({
  requestId: z.string().min(1).max(256),
  questions: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        header: z.string().max(500),
        question: z.string().max(20000),
        isSecret: z.boolean().optional(),
        multiSelect: z.boolean().optional(),
        options: z
          .array(z.object({ label: z.string().max(2000), description: z.string().max(5000) }))
          .max(50)
          .nullable()
          .optional(),
      }),
    )
    .min(1)
    .max(20),
});
export type ChatQuestion = z.infer<typeof ChatQuestionSchema>;
export const CHAT_QUESTION_DISMISS_ANSWER =
  "The user dismissed this question without answering. Continue with your best judgment; ask again only if you are truly blocked.";
export const ChatAnswersSchema = z
  .record(z.string().min(1).max(256), z.array(z.string().max(20000)).min(1).max(20))
  .refine((value) => Object.keys(value).length <= 20, "Too many answers");
/**
 * The transcript record of a question answer: one readable line per question.
 * Secret answers never enter the stored conversation, and a dismissal reads as
 * the user's choice, not the instruction the agent receives. Dismissing is the
 * user's own action, so a sole dismissal reads "(dismissed)" even for a secret
 * question; alongside real values the sentinel is dropped and the values show.
 * Question labels are agent-controlled text stored under the user's role; the
 * whitespace collapse keeps them from forging extra transcript lines.
 */
export function chatAnswerText(question: ChatQuestion, answers: Record<string, string[]>): string {
  return question.questions
    .map((entry) => {
      const label = (entry.question || entry.header).replace(/\s+/g, " ").trim();
      const values = answers[entry.id] ?? [];
      const text =
        values.length === 1 && values[0] === CHAT_QUESTION_DISMISS_ANSWER
          ? "(dismissed)"
          : entry.isSecret
            ? "(hidden)"
            : values
                .filter((value) => value !== CHAT_QUESTION_DISMISS_ANSWER)
                .map((value) => value.replace(/\s+/g, " ").trim())
                .filter(Boolean)
                .join(", ");
      // Clip by code point so a label never ends in half a surrogate pair.
      const chars = Array.from(label);
      const clipped = chars.length > 200 ? `${chars.slice(0, 197).join("")}…` : label;
      return `${clipped}: ${text || "(no answer)"}`;
    })
    .join("\n");
}
export const ChatSettingsSchema = z
  .object({
    providerId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      .optional(),
    agent: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/i)
      .default("codex"),
    model: ChatModelSchema.default(""),
    models: z
      .array(
        z
          .object({
            agent: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/i),
            id: ChatModelSchema.refine((value) => value.length > 0),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    system: z.string().max(20000).default(CHAT_SYSTEM_PROMPT),
    autoApprove: z.boolean().default(false),
    permissionMode: ChatPermissionModeSchema.optional(),
    // What Enter/Send does while a response is running: join the live turn where the
    // backend accepts steering, or hold the message for the next turn.
    sendWhileRunning: z.enum(["steer", "queue"]).default("steer"),
    agentOptions: ChatAgentOptionsMapSchema.default({}),
    mcp: z.enum(["orc", "native"]).default("orc"),
  })
  .strict();
export type ChatSettings = z.infer<typeof ChatSettingsSchema>;
const ChatAgentIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/i);
export const FavoriteModelSchema = z
  .object({ agent: ChatAgentIdSchema, id: ChatModelSchema.refine((value) => value.length > 0) })
  .strict();
export type FavoriteModel = z.infer<typeof FavoriteModelSchema>;
export const ComposerProfileSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
    name: z.string().trim().min(1).max(60),
    agent: ChatAgentIdSchema,
    providerId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      .optional(),
    model: ChatModelSchema.default(""),
    effort: z
      .string()
      .regex(/^$|^[a-z][a-z0-9_-]{0,31}$/i)
      .default(""),
    permissionMode: ChatPermissionModeSchema.optional(),
  })
  .strict();
export type ComposerProfile = z.infer<typeof ComposerProfileSchema>;
export const FavoriteModelsSchema = z.array(FavoriteModelSchema).max(100);
export const ComposerProfilesSchema = z
  .array(ComposerProfileSchema)
  .max(50)
  .refine(
    (profiles) => new Set(profiles.map((profile) => profile.id)).size === profiles.length,
    "Profile ids must be unique",
  );
export const ChatModelsSchema = z.object({
  models: z.array(
    z.object({
      id: ChatModelSchema,
      label: z.string().max(120),
      description: z.string().max(300).optional(),
      efforts: z.array(z.string().min(1).max(64)).max(16).optional(),
    }),
  ),
  warning: z.string().nullable(),
  /** Live effort levels for the agent's default model, when it exposes them. */
  effortChoices: z
    .array(z.object({ value: z.string().min(1).max(64), label: z.string().min(1).max(120) }))
    .max(16)
    .optional(),
});
export type ChatModels = z.infer<typeof ChatModelsSchema>;

export const AGENT_COMMAND_PATTERN = /^\/[\p{L}\p{N}][\p{L}\p{N}_:.-]*(?:\s|$)/u;

export const ChatAgentCommandSchema = z.object({
  name: z.string().max(200),
  token: z.string().max(201),
  description: z.string().max(1000),
  argumentHint: z.string().max(500),
  aliases: z.array(z.string().max(200)).max(20),
  source: z.string().max(120),
});
export type ChatAgentCommand = z.infer<typeof ChatAgentCommandSchema>;
export const ChatAgentCommandsSchema = z.object({
  commands: z.array(ChatAgentCommandSchema),
  warning: z.string().nullable(),
});
export type ChatAgentCommands = z.infer<typeof ChatAgentCommandsSchema>;

export const ChatFileEntrySchema = z.object({ name: z.string(), directory: z.boolean() });
export const ChatFilesSchema = z.object({ entries: z.array(ChatFileEntrySchema) });
export type ChatFiles = z.infer<typeof ChatFilesSchema>;

/**
 * What a tool call leaves running after it returns: a shell command the agent detached
 * (a dev server, a test run) or a subagent it delegated to. A backend sets
 * `run_in_background`; the tool result then arrives at once and the work continues.
 */
export const CHAT_BACKGROUND_KINDS = ["command", "subagent"] as const;
export type ChatBackgroundKind = (typeof CHAT_BACKGROUND_KINDS)[number];

const BACKGROUND_FLAGS = ["run_in_background", "runInBackground", "background", "detached"];
const SUBAGENT_TOOL_NAME = /task|agent|subagent|delegate|spawn/i;

/**
 * Reads a tool call's declared background work. Every common backend that can detach a
 * command or a subagent marks it in the call input, so this reads the input rather than
 * naming each backend's tool.
 */
export function chatBackgroundKind(name: string, input: string): ChatBackgroundKind | null {
  let parsed: unknown;
  try {
    parsed = input.trim() ? JSON.parse(input) : null;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (!BACKGROUND_FLAGS.some((flag) => record[flag] === true)) return null;
  return SUBAGENT_TOOL_NAME.test(name) ? "subagent" : "command";
}

export const ChatPlanEntryStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);
export type ChatPlanEntryStatus = z.infer<typeof ChatPlanEntryStatusSchema>;
/** Providers re-send the whole plan on every update; keep the transcript bounded. */
export const CHAT_PLAN_MAX_ENTRIES = 50;
export const ChatPlanEntrySchema = z.object({
  id: z.string().min(1).max(200),
  status: ChatPlanEntryStatusSchema,
  content: z.string().max(2000),
});
export type ChatPlanEntry = z.infer<typeof ChatPlanEntrySchema>;
const ChatPlanPayloadSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().max(200).optional(),
  entries: z.array(ChatPlanEntrySchema).max(CHAT_PLAN_MAX_ENTRIES),
});
export type ChatPlanPayload = z.infer<typeof ChatPlanPayloadSchema>;
export const ChatPlanSchema = ChatPlanPayloadSchema.extend({ type: z.literal("plan") });
export type ChatPlan = z.infer<typeof ChatPlanSchema>;

const ChatThinkingSchema = z.object({
  type: z.literal("thinking"),
  id: z.string(),
  text: z.string(),
});
const ChatToolSchema = z.object({
  type: z.literal("tool"),
  id: z.string(),
  name: z.string(),
  input: z.string(),
  result: z.string().optional(),
  isError: z.boolean().optional(),
  /** When the call was announced, so a long-running call can show its elapsed time. */
  startedAt: z.number().finite().nonnegative().optional(),
  /** Work the call left running; it can outlive the turn that started it. */
  background: z.enum(CHAT_BACKGROUND_KINDS).optional(),
});
const ChatStatusSchema = z.object({ type: z.literal("status"), id: z.string(), text: z.string() });

/**
 * A subagent's own transcript, streamed live while the parent turn runs and kept
 * with it afterwards. The whole block is re-sent on every change (like a plan),
 * so it updates in place instead of appending a row per child event.
 */
export const CHAT_SUBAGENT_MAX_ITEMS = 50;
export const CHAT_SUBAGENT_DONE = new Set(["completed", "failed", "stopped"]);
export const ChatSubagentStatusSchema = z.enum([
  "running",
  "waiting",
  "completed",
  "failed",
  "stopped",
]);
export type ChatSubagentStatus = z.infer<typeof ChatSubagentStatusSchema>;
export const ChatSubagentPayloadSchema = z.object({
  /** The child session's native id. */
  id: z.string().min(1).max(200),
  /** The subagent that spawned this one; absent when the main agent did. */
  parentId: z.string().min(1).max(200).optional(),
  title: z.string().max(200).optional(),
  status: ChatSubagentStatusSchema,
  startedAt: z.number().finite().nonnegative().optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  tokens: z.number().int().nonnegative().optional(),
  activity: z
    .array(z.discriminatedUnion("type", [ChatThinkingSchema, ChatToolSchema, ChatStatusSchema]))
    .max(CHAT_SUBAGENT_MAX_ITEMS),
  /** The child's answer text, accumulated as it streams. */
  text: z.string().max(100000).optional(),
});
export type ChatSubagentPayload = z.infer<typeof ChatSubagentPayloadSchema>;
/** The child transcript's own items: no nested subagents or plans. */
export type ChatSubagentActivity = ChatSubagentPayload["activity"];
export const ChatSubagentSchema = ChatSubagentPayloadSchema.extend({
  type: z.literal("subagent"),
});
export type ChatSubagent = z.infer<typeof ChatSubagentSchema>;

export const ChatActivitySchema = z.discriminatedUnion("type", [
  ChatThinkingSchema,
  ChatToolSchema,
  ChatStatusSchema,
  ChatPlanSchema,
  ChatSubagentSchema,
]);
export type ChatActivity = z.infer<typeof ChatActivitySchema>;

/**
 * An activity kind this build does not know, kept verbatim so an older client
 * saving a newer session's transcript does not drop the agent's data.
 */
export const ChatProviderActivitySchema = z.object({
  id: z.string(),
  kind: z.string().min(1).max(64),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type ChatProviderActivity = z.infer<typeof ChatProviderActivitySchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Splits stored activity into the kinds this build renders and the rest, without throwing. */
export function readChatActivity(value: unknown): {
  activity: ChatActivity[];
  provider: ChatProviderActivity[];
} {
  const activity: ChatActivity[] = [];
  const provider: ChatProviderActivity[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    const known = ChatActivitySchema.safeParse(item);
    if (known.success) {
      activity.push(known.data);
      continue;
    }
    const raw = isRecord(item) ? item : {};
    provider.push({
      id: typeof raw.id === "string" ? raw.id : crypto.randomUUID(),
      kind: typeof raw.type === "string" && raw.type ? raw.type.slice(0, 64) : "unknown",
      ...(Object.keys(raw).length ? { data: raw } : {}),
    });
  }
  return { activity: activity.slice(-200), provider: provider.slice(-200) };
}

/** Normalized transcript item: identity and nesting now, paging in wave 3. */
export type ChatItemKind = ChatActivity["type"] | "provider";
export type ChatItem = {
  id: string;
  ordinal: number;
  parentId?: string | undefined;
  status?: ChatPlanEntryStatus | undefined;
} & (
  | { kind: "thinking"; text: string }
  | { kind: "status"; text: string }
  | { kind: "tool"; name: string; input: string; result?: string; isError?: boolean }
  | { kind: "plan"; title?: string; entries: ChatPlanEntry[] }
  | {
      kind: "subagent";
      title?: string;
      subagentStatus: ChatSubagentStatus;
      activity: ChatSubagentActivity;
      text?: string;
    }
  | { kind: "provider"; provider: string; data?: Record<string, unknown> }
);
/** How many items an expanded turn renders before offering the rest. */
export const CHAT_ITEM_WINDOW = 80;

/**
 * The parent a provider activity's data names, under the field names adapters use:
 * an explicit parent, or the tool call the activity belongs to. Anything else is
 * left un-nested rather than guessed.
 */
function providerParentId(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  for (const key of [
    "parentId",
    "parent_id",
    "parentToolUseId",
    "parent_tool_use_id",
    "toolUseId",
    "tool_use_id",
  ]) {
    const value = data[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/**
 * Builds one turn's normalized items: one per known activity in stored order, then
 * one `provider` item per kind this build does not know. The provider items are
 * appended because wave 1 moved those kinds into a separate list, so their original
 * position among the known activities is no longer recoverable.
 *
 * `startedAt` and `background` stay on the raw activity: the live trail and
 * background-work row read those, and no item row renders elapsed tool time.
 */
export function buildChatItems(message: {
  activity?: readonly ChatActivity[] | undefined;
  providerActivity?: readonly ChatProviderActivity[] | undefined;
}): ChatItem[] {
  const activity = Array.isArray(message.activity) ? message.activity : [];
  const providerActivity = Array.isArray(message.providerActivity) ? message.providerActivity : [];
  const toolIds = new Set(activity.flatMap((item) => (item.type === "tool" ? [item.id] : [])));
  const items: ChatItem[] = [];
  for (const item of activity) {
    const ordinal = items.length;
    if (item.type === "thinking") {
      items.push({ id: item.id, ordinal, kind: "thinking", text: item.text });
      continue;
    }
    if (item.type === "status") {
      items.push({ id: item.id, ordinal, kind: "status", text: item.text });
      continue;
    }
    if (item.type === "plan") {
      items.push({
        id: item.id,
        ordinal,
        kind: "plan",
        ...(item.title === undefined ? {} : { title: item.title }),
        entries: item.entries,
      });
      continue;
    }
    if (item.type === "subagent") {
      items.push({
        id: item.id,
        ordinal,
        kind: "subagent",
        ...(item.title === undefined ? {} : { title: item.title }),
        subagentStatus: item.status,
        activity: item.activity,
        ...(item.text === undefined ? {} : { text: item.text }),
      });
      continue;
    }
    items.push({
      id: item.id,
      ordinal,
      kind: "tool",
      name: item.name,
      input: item.input,
      ...(item.result === undefined ? {} : { result: item.result }),
      ...(item.isError === undefined ? {} : { isError: item.isError }),
      ...(item.isError ? { status: "failed" as const } : {}),
    });
  }
  for (const item of providerActivity) {
    const parentId = providerParentId(item.data);
    items.push({
      id: item.id,
      ordinal: items.length,
      kind: "provider",
      provider: item.kind,
      ...(parentId && toolIds.has(parentId) ? { parentId } : {}),
      ...(item.data === undefined ? {} : { data: item.data }),
    });
  }
  return items;
}

export const ChatTurnSchema = z.object({
  startedAt: z.number().finite().nonnegative(),
  finishedAt: z.number().finite().nonnegative().optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  // `interrupted` is a turn the daemon could not finish (restart, crash, killed
  // process). It is distinct from `stopped` (the user stopped it) and `failed`
  // (the agent errored): the turn record tells the reader that the work was cut
  // off and that the conversation resumes where it left off.
  outcome: z.enum(["completed", "stopped", "failed", "interrupted"]).optional(),
  // Frozen at turn end so a finished turn's token figure does not keep drifting
  // as the session records later requests.
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      cached_input_tokens: z.number().int().nonnegative(),
      context_tokens: z.number().int().nonnegative().optional(),
      context_window: z.number().int().positive().optional(),
    })
    .optional(),
});
export type ChatTurn = z.infer<typeof ChatTurnSchema>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.number(),
  turn: ChatTurnSchema.optional(),
  agent: z.string().optional(),
  /** The model that produced this turn, when the session records one. */
  model: ChatModelSchema.optional(),
  activity: z.array(ChatActivitySchema).optional(),
  providerActivity: z.array(ChatProviderActivitySchema).max(200).optional(),
  attachments: z.array(SessionFileSchema).max(10).optional(),
  deliveries: z.array(SessionDeliverySchema).max(20).optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export const CHAT_HISTORY_PAGE_SIZE = 500;
export const ChatHistoryPageSchema = z.object({
  messages: z.array(ChatMessageSchema),
  before: z.number().int().nonnegative().nullable(),
});
export type ChatHistoryPage = z.infer<typeof ChatHistoryPageSchema>;
export const ChatWorkspaceSchema = z
  .object({
    host: z
      .string()
      .max(255)
      .regex(
        /^(?:orc:[a-z0-9][a-z0-9-]{0,63}(?:\/[A-Za-z0-9_.@][A-Za-z0-9_.@-]*)?|[A-Za-z0-9_.@][A-Za-z0-9_.@-]*)$/,
      )
      .nullable()
      .optional(),
    cwd: z.string().trim().max(4096).optional(),
    worktree: z.boolean().default(false),
    /** Ref the new worktree branches from. Omitted means the checkout's current HEAD. */
    base: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine(
        (value) =>
          !value.startsWith("-") &&
          [...value].every((char) => {
            const code = char.codePointAt(0) ?? 0;
            return code > 0x1f && code !== 0x7f && !/\s/.test(char);
          }),
        "Choose a Git branch name",
      )
      .optional(),
  })
  .strict()
  .refine(
    (value) => !value.worktree || !!value.cwd?.trim(),
    "Choose a folder before creating a worktree",
  )
  .refine(
    (value) => !value.base || value.worktree,
    "Choose to create a worktree before selecting a base branch",
  );
export type ChatWorkspace = z.infer<typeof ChatWorkspaceSchema>;

const DRAFT_CHECKOUT_PREFIX = "draft:";

function encodeDraftPayload(payload: { host: string | null; cwd: string }): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeDraftPayload(encoded: string): { host: string | null; cwd: string } | null {
  try {
    const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed.cwd !== "string" || !parsed.cwd) return null;
    return { host: typeof parsed.host === "string" ? parsed.host : null, cwd: parsed.cwd };
  } catch {
    return null;
  }
}

export function draftCheckoutId(workspace: Pick<ChatWorkspace, "host" | "cwd">): string | null {
  const cwd = workspace.cwd?.trim();
  if (!cwd) return null;
  return DRAFT_CHECKOUT_PREFIX + encodeDraftPayload({ host: workspace.host ?? null, cwd });
}

export function parseDraftCheckoutId(id: string): { host: string | null; cwd: string } | null {
  if (!id.startsWith(DRAFT_CHECKOUT_PREFIX)) return null;
  return decodeDraftPayload(id.slice(DRAFT_CHECKOUT_PREFIX.length));
}

/** How a fork continues the source conversation. */
export const ChatForkModeSchema = z.enum(["native", "context"]);
export type ChatForkMode = z.infer<typeof ChatForkModeSchema>;

export const ChatForkSchema = z.object({
  threadId: z.string().uuid(),
  messageId: z.string(),
  mode: ChatForkModeSchema,
  /** Kept for the fork notice without an extra round trip to the source chat. */
  sourceTitle: z.string().max(500).optional(),
  /** Why native was unavailable, or why a native attempt fell back to context. */
  fallbackReason: z.string().max(500).optional(),
  /** The copied display transcript is missing older messages. */
  partial: z.boolean().optional(),
});
export type ChatFork = z.infer<typeof ChatForkSchema>;

/**
 * A native fork starts lazily on the first turn: the source session must not be
 * touched by the fork request, and some backends only expose the new identity
 * after that turn.
 */
export const ChatForkPendingSchema = z.object({
  threadId: z.string().uuid(),
  messageId: z.string(),
  sourceRuntimeId: z.string().min(1).max(256),
  sourceBackend: z.string().min(1).max(64),
  sourceHost: z.string().nullable(),
  sourceAgent: z.string().min(1).max(64),
  sourceCwd: z.string(),
});
export type ChatForkPending = z.infer<typeof ChatForkPendingSchema>;

/** How much of the source conversation a portable fork carries into its first turn. */
export const ChatForkContextSchema = z.object({
  messageCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  includesActivity: z.boolean(),
});
export type ChatForkContext = z.infer<typeof ChatForkContextSchema>;

export const ChatSpawnSchema = z.object({
  sessionId: z.string().min(1).max(200),
  requestId: z.string().min(1).max(128).optional(),
  at: z.number().int().nonnegative(),
  notify: z.boolean(),
  prompt: z.string().max(100000).optional(),
  cancelled: z.boolean().optional(),
  startError: z.string().max(2000).optional(),
});
export type ChatSpawn = z.infer<typeof ChatSpawnSchema>;

/**
 * The thread-level lease over the current turn. Written at turn start, made
 * terminal at turn end, and reconciled at daemon boot: a `running` lease whose
 * pid/host is gone is `interrupted`, never `failed` — the native session behind
 * it survives and the next send resumes it.
 */
export const ChatTurnLeaseStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "stopped",
  "interrupted",
]);
export type ChatTurnLeaseStatus = z.infer<typeof ChatTurnLeaseStatusSchema>;
/** A chat turn is force-ended at this age, whatever the agent is doing. */
export const CHAT_TURN_HARD_LIMIT_MS = 4 * 60 * 60 * 1000;
/**
 * A `running` lease older than this cannot still have a live writer: the daemon
 * has already force-ended the turn at its hard limit, so anything older is a
 * leftover from a process that died. Recovery also uses it to discount a
 * recycled OS pid, which would otherwise present a dead lease as live forever.
 */
export const CHAT_TURN_LEASE_STALE_MS = CHAT_TURN_HARD_LIMIT_MS + 61_000;
export const ChatTurnLeaseSchema = z.object({
  runId: z.string().uuid(),
  startedAt: z.number().finite().nonnegative(),
  status: ChatTurnLeaseStatusSchema,
  lastHeartbeatAt: z.number().finite().nonnegative().optional(),
  /** Daemon that owns the turn; with `pid` it proves or disproves liveness. */
  host: z.string().max(255).optional(),
  pid: z.number().int().positive().optional(),
  /**
   * Monotonic fencing token, bumped by every turn that claims the thread. A
   * mid-turn or terminal write carries the epoch it was issued under, so a
   * resurrected process or a second daemon sharing this database cannot
   * overwrite a newer turn's lease. Records written before the field existed
   * read as epoch 0.
   */
  epoch: z.number().int().nonnegative().optional(),
});
export type ChatTurnLease = z.infer<typeof ChatTurnLeaseSchema>;

/**
 * A native session identity this thread attached to. The history is kept: an
 * older ref may still be resumable after a provider switch or a failed resume,
 * so recovery can try it instead of starting from nothing. Most recent last.
 */
export const CHAT_PROVIDER_REFS_MAX = 20;
export const ChatProviderRefSourceSchema = z.enum(["started", "resumed"]);
export type ChatProviderRefSource = z.infer<typeof ChatProviderRefSourceSchema>;
export const ChatProviderRefSchema = z.object({
  backend: z.string(),
  host: z.string().nullable(),
  runtimeId: z.string(),
  cwd: z.string(),
  attachedAt: z.number().finite().nonnegative(),
  source: ChatProviderRefSourceSchema,
});
export type ChatProviderRef = z.infer<typeof ChatProviderRefSchema>;

/** The last recovery this thread went through, for the UI's recovery notice. */
export const ChatRecoveryModeSchema = z.enum(["transcript_handoff"]);
export type ChatRecoveryMode = z.infer<typeof ChatRecoveryModeSchema>;
export const ChatRecoverySchema = z.object({
  at: z.number().finite().nonnegative(),
  mode: ChatRecoveryModeSchema,
  reason: z.string().max(500),
});
export type ChatRecovery = z.infer<typeof ChatRecoverySchema>;

export const ChatThreadSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  config: ChatSettingsSchema,
  cwd: z.string(),
  host: z.string().nullable(),
  runtimeId: z.string().nullable(),
  backend: z.string(),
  capabilities: AgentCapabilitiesSchema.optional(),
  sourceId: z.string().nullable(),
  toolAllowlist: z.array(z.string()).optional(),
  messages: z.array(ChatMessageSchema),
  historyBefore: z.number().int().nonnegative().nullable().optional(),
  importedMessages: z.number().int().nonnegative().optional(),
  projectId: z.string().optional(),
  secretRefs: SecretRefsMapSchema.optional(),
  transcriptMark: z.string().max(100).optional(),
  // The source conversation and answer this chat was forked from. `mode` records
  // whether the new chat continues a native provider session or replays a
  // portable transcript; `partial` marks an incomplete copied display history.
  forkedFrom: ChatForkSchema.optional(),
  // Present only while a native fork has not created its session yet. The first
  // turn consumes it, then either establishes the native session or falls back.
  forkPending: ChatForkPendingSchema.optional(),
  // The portable context a fork delivered on its first turn, for the UI notice.
  forkContext: ChatForkContextSchema.optional(),
  // Set when an account switch drops the native session; the next turn replays
  // bounded prior context so the conversation can continue in the new account.
  providerSwitch: z.object({ from: z.string() }).optional(),
  // Set once a turn confirmed the agent received the chat instructions. Until
  // then every turn offers them again, so a first turn that failed before
  // delivery cannot lose them for the life of the conversation.
  systemPromptDelivered: z.boolean().optional(),
  // A moved session's one-time handoff briefing; the first turn delivers it and
  // clears it, so later turns never repeat it.
  handoffBriefing: z.string().max(16000).optional(),
  // The current/last turn's lease. A daemon crash leaves it `running`; the next
  // boot reconciles it to `interrupted` without touching the resumable identity.
  turn: ChatTurnLeaseSchema.optional(),
  // Every native identity this thread attached to, most recent last. Never lose
  // a ref that may still be resumable.
  providerRefs: z.array(ChatProviderRefSchema).max(CHAT_PROVIDER_REFS_MAX).optional(),
  // The last recovery applied to this thread (resume, discovery, transcript handoff).
  recovery: ChatRecoverySchema.optional(),
  spawnedBy: ChatSpawnSchema.optional(),
  updatedAt: z.number(),
});
export type ChatThread = z.infer<typeof ChatThreadSchema>;

/**
 * Reads a stored thread without failing on an activity kind this build does not
 * know: those items move to `providerActivity` and survive the next save.
 */
export function parseChatThread(value: unknown): ChatThread {
  if (!isRecord(value) || !Array.isArray(value.messages)) return ChatThreadSchema.parse(value);
  return ChatThreadSchema.parse({
    ...value,
    messages: value.messages.map((message) => {
      if (!isRecord(message) || !Array.isArray(message.activity)) return message;
      const { activity, provider } = readChatActivity(message.activity);
      const existing = Array.isArray(message.providerActivity) ? message.providerActivity : [];
      return {
        ...message,
        activity,
        ...(provider.length ? { providerActivity: [...existing, ...provider].slice(-200) } : {}),
      };
    }),
  });
}
/**
 * The only send refusal the always-resumable contract allows: a genuinely live
 * run owns the session and the client did not confirm pushing into it. Clients
 * recognize it by this code and decide whether to offer the confirmation.
 */
export const CHAT_SESSION_BUSY_CODE = "SESSION_BUSY";

export const ChatEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn"), turn: ChatTurnSchema }),
  z.object({ type: z.literal("narration"), text: z.string() }),
  z.object({ type: z.literal("capabilities"), capabilities: AgentCapabilitiesSchema }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking"), text: z.string() }),
  z.object({ type: z.literal("system_status"), text: z.string() }),
  z.object({ type: z.literal("plan"), data: ChatPlanPayloadSchema }),
  z.object({ type: z.literal("subagent"), data: ChatSubagentPayloadSchema }),
  z.object({
    type: z.literal("tool_use"),
    data: z.object({ id: z.string(), name: z.string(), input: z.string() }),
  }),
  z.object({
    type: z.literal("tool_result"),
    data: z.object({ toolUseId: z.string(), content: z.string(), isError: z.boolean() }),
  }),
  z.object({
    type: z.literal("permission_request"),
    data: z.object({
      requestId: z.string(),
      tool: z.string(),
      command: z.string(),
      input: z.record(z.string(), z.unknown()).optional(),
      allowSession: z.boolean().optional(),
    }),
  }),
  z.object({ type: z.literal("question_request"), data: ChatQuestionSchema }),
  z.object({ type: z.literal("request_resolved"), requestId: z.string() }),
  // A human message joined the running turn (a steer or a question answer). The
  // prose streamed before it is sealed as its own assistant segment, so the
  // transcript keeps the order things actually happened in.
  z.object({ type: z.literal("interjection"), message: ChatMessageSchema }),
  // Slim: thread metadata plus the turn's user message only; the full transcript
  // is read from GET /chat/threads/{id}.
  z.object({ type: z.literal("thread"), thread: ChatThreadSchema, runId: z.string().uuid() }),
  z.object({
    type: z.literal("remote"),
    host_id: z.string(),
    host_label: z.string(),
    url: z.string(),
    thread_id: z.string(),
    run_id: z.string(),
    open_url: z.string(),
  }),
  z.object({ type: z.literal("session"), runtimeId: z.string().nullable() }),
  z.object({
    type: z.literal("error"),
    message: z.string().catch("The agent could not complete the response."),
  }),
]);
export type ChatEvent = z.infer<typeof ChatEventSchema> | { type: "done" };

/**
 * Plans arrive as whole snapshots that change in place: entries keep their id,
 * so a repeated identical update is a no-op and status flapping never appends a
 * second row. A different plan id starts a new plan block in the same turn.
 */
function mergeChatPlan(activity: ChatActivity[], incoming: ChatPlanPayload): ChatActivity[] {
  const entries = incoming.entries.slice(0, CHAT_PLAN_MAX_ENTRIES);
  let at = -1;
  for (let index = activity.length - 1; index >= 0; index--) {
    const item = activity[index];
    if (item?.type === "plan" && item.id === incoming.id) {
      at = index;
      break;
    }
  }
  if (at === -1)
    return [
      ...activity,
      {
        type: "plan",
        id: incoming.id,
        ...(incoming.title ? { title: incoming.title } : {}),
        entries,
      },
    ].slice(-200) as ChatActivity[];
  const current = activity[at] as ChatPlan;
  const merged = current.entries.map((entry) => ({ ...entry }));
  let changed = false;
  for (const entry of entries) {
    const found = merged.findIndex((item) => item.id === entry.id);
    if (found === -1) {
      if (merged.length >= CHAT_PLAN_MAX_ENTRIES) continue;
      merged.push({ ...entry });
      changed = true;
      continue;
    }
    const previous = merged[found] as ChatPlanEntry;
    if (previous.status === entry.status && previous.content === entry.content) continue;
    merged[found] = { ...entry };
    changed = true;
  }
  const title = incoming.title ?? current.title;
  if (!changed && title === current.title) return activity;
  const next = [...activity];
  next[at] = { type: "plan", id: current.id, ...(title ? { title } : {}), entries: merged };
  return next;
}

/**
 * Whether an activity list holds the entry a stateful event updates. A seal splits
 * the turn's activity across segments; results, plan snapshots and subagent status
 * must route to the segment that owns the entry instead of orphaning it above the
 * interjection and synthesizing a nameless stub below.
 */
export function ownsChatActivity(activity: ChatActivity[] | undefined, event: ChatEvent): boolean {
  if (!activity?.length) return false;
  // ACP/ACPX re-announce a tool_use with the same id on every update; the claim
  // keeps the update (and its later result) in the segment that started the call.
  if (event.type === "tool_use")
    return activity.some((item) => item.type === "tool" && item.id === event.data.id);
  if (event.type === "tool_result")
    return activity.some((item) => item.type === "tool" && item.id === event.data.toolUseId);
  if (event.type === "subagent")
    return activity.some((item) => item.type === "subagent" && item.id === event.data.id);
  if (event.type === "plan") return activity.some((item) => item.type === "plan");
  return false;
}

export function appendChatActivity(activity: ChatActivity[], event: ChatEvent): ChatActivity[] {
  if (event.type === "thinking") {
    const last = activity[activity.length - 1];
    if (last?.type === "thinking")
      return [...activity.slice(0, -1), { ...last, text: (last.text + event.text).slice(-100000) }];
    return [...activity, { type: "thinking", id: crypto.randomUUID(), text: event.text }].slice(
      -200,
    ) as ChatActivity[];
  }
  if (event.type === "tool_use") {
    if (activity.some((item) => item.type === "tool" && item.id === event.data.id))
      return activity.map((item) =>
        item.type === "tool" && item.id === event.data.id ? { ...item, ...event.data } : item,
      );
    const background = chatBackgroundKind(event.data.name, event.data.input);
    return [
      ...activity,
      {
        type: "tool",
        ...event.data,
        startedAt: Date.now(),
        ...(background ? { background } : {}),
      },
    ].slice(-200) as ChatActivity[];
  }
  if (event.type === "tool_result") {
    const existing = activity.some(
      (item) => item.type === "tool" && item.id === event.data.toolUseId,
    );
    const items = existing
      ? activity
      : [
          ...activity,
          {
            type: "tool" as const,
            id: event.data.toolUseId,
            name: "Tool",
            input: "",
            startedAt: Date.now(),
          },
        ];
    return items
      .map((item) =>
        item.type === "tool" && item.id === event.data.toolUseId
          ? { ...item, result: event.data.content, isError: event.data.isError }
          : item,
      )
      .slice(-200);
  }
  if (event.type === "system_status" || event.type === "narration")
    return [...activity, { type: "status", id: crypto.randomUUID(), text: event.text }].slice(
      -200,
    ) as ChatActivity[];
  if (event.type === "plan") return mergeChatPlan(activity, event.data);
  if (event.type === "subagent") {
    const incoming: ChatSubagent = {
      type: "subagent",
      ...event.data,
      activity: event.data.activity.slice(0, CHAT_SUBAGENT_MAX_ITEMS),
    };
    const at = activity.findIndex((item) => item.type === "subagent" && item.id === incoming.id);
    if (at === -1) return [...activity, incoming].slice(-200) as ChatActivity[];
    const next = [...activity];
    next[at] = incoming;
    return next;
  }
  return activity;
}
