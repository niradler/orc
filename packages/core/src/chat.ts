import { z } from "zod";
import { ChatAgentOptionsMapSchema, ChatPermissionModeSchema } from "./chat-options.js";
import { SessionFileSchema } from "./session-file-types.js";

export const CHAT_AGENTS = ["codex", "claude", "cursor", "gemini", "copilot"] as const;
export function nativeChatAgent(agent: string): string | null {
  return ["claude", "codex", "gemini"].includes(agent) ? agent : null;
}

export function nativeChatResumeUnavailableReason(agent: string): string | null {
  if (agent === "cursor-agent")
    return "Cursor CLI and ACP chat use separate session stores. Use Terminal to resume this conversation.";
  return nativeChatAgent(agent)
    ? null
    : "This session provider cannot resume in chat. Use Terminal when available.";
}

export { ChatPermissionModeSchema } from "./chat-options.js";

export const ORC_TASK_GUIDANCE = `When real task work is needed, discover and read relevant built-in ORC skills using skill_list and skill_read: orc-sdlc for engineering work and orc-platform for ORC operations. For nontrivial work, get the selected project's context first and follow the current skill guidance. Discover relevant tools as needed. Answer simple conversation directly.`;

export const CHAT_SYSTEM_PROMPT = `You are the ORC platform chat assistant.

${ORC_TASK_GUIDANCE}
Share relevant ORC links: session pages for reading, supported chat or terminal actions for resuming. Follow the session guidance.
Use scratchpads to collaborate on plans, diagrams, and HTML artifacts; share their links and preserve human edits.
Manage longer work through ORC tasks, progress updates, and handoffs.`;
/** Kept out of the editable prompt so custom prompts still get it; details live in ui_catalog. */
export const ORC_CHAT_CONTEXT_GUIDANCE = `Turns may start with ORC's hidden <orc-context> block (source, dashboard route or channel sender); use it without quoting it. Default to Markdown for ordinary answers and static status summaries. Only in webchat, when live monitoring, direct interaction or a saved scratchpad artifact adds value, read ui_catalog and use the smallest useful component reply.`;

export function chatSystemPrompt(system = CHAT_SYSTEM_PROMPT): string {
  return [system, ORC_TASK_GUIDANCE, ORC_CHAT_CONTEXT_GUIDANCE]
    .filter((part, index) => index === 0 || !system.includes(part))
    .join("\n\n");
}

export const ChatModelSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^$|^[a-z0-9][a-z0-9._:/@+-]*$/i);
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
export const ChatAnswersSchema = z
  .record(z.string().min(1).max(256), z.array(z.string().max(20000)).min(1).max(20))
  .refine((value) => Object.keys(value).length <= 20, "Too many answers");
export const ChatSettingsSchema = z
  .object({
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
    agentOptions: ChatAgentOptionsMapSchema.default({}),
    mcp: z.enum(["orc", "native"]).default("orc"),
  })
  .strict();
export type ChatSettings = z.infer<typeof ChatSettingsSchema>;
export const ChatModelsSchema = z.object({
  models: z.array(z.object({ id: ChatModelSchema, label: z.string().max(120) })),
  warning: z.string().nullable(),
});
export type ChatModels = z.infer<typeof ChatModelsSchema>;
export const ChatActivitySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thinking"), id: z.string(), text: z.string() }),
  z.object({
    type: z.literal("tool"),
    id: z.string(),
    name: z.string(),
    input: z.string(),
    result: z.string().optional(),
    isError: z.boolean().optional(),
  }),
  z.object({ type: z.literal("status"), id: z.string(), text: z.string() }),
]);
export type ChatActivity = z.infer<typeof ChatActivitySchema>;
export const ChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.number(),
  agent: z.string().optional(),
  activity: z.array(ChatActivitySchema).optional(),
  attachments: z.array(SessionFileSchema).max(10).optional(),
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
      .regex(/^[A-Za-z0-9_.@][A-Za-z0-9_.@-]*$/)
      .nullable()
      .optional(),
    cwd: z.string().trim().max(4096).optional(),
    worktree: z.boolean().default(false),
  })
  .strict()
  .refine(
    (value) => !value.worktree || !!value.cwd?.trim(),
    "Choose a folder before creating a worktree",
  );
export type ChatWorkspace = z.infer<typeof ChatWorkspaceSchema>;
export const ChatThreadSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  config: ChatSettingsSchema,
  cwd: z.string(),
  host: z.string().nullable(),
  runtimeId: z.string().nullable(),
  backend: z.string(),
  sourceId: z.string().nullable(),
  toolAllowlist: z.array(z.string()).optional(),
  messages: z.array(ChatMessageSchema),
  historyBefore: z.number().int().nonnegative().nullable().optional(),
  importedMessages: z.number().int().nonnegative().optional(),
  projectId: z.string().optional(),
  updatedAt: z.number(),
});
export type ChatThread = z.infer<typeof ChatThreadSchema>;
export const ChatEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking"), text: z.string() }),
  z.object({ type: z.literal("system_status"), text: z.string() }),
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
    data: z.object({ requestId: z.string(), tool: z.string(), command: z.string() }),
  }),
  z.object({ type: z.literal("question_request"), data: ChatQuestionSchema }),
  z.object({ type: z.literal("request_resolved"), requestId: z.string() }),
  z.object({ type: z.literal("thread"), thread: ChatThreadSchema, runId: z.string().uuid() }),
  z.object({ type: z.literal("session"), runtimeId: z.string().nullable() }),
  z.object({
    type: z.literal("error"),
    message: z.string().catch("The agent could not complete the response."),
  }),
]);
export type ChatEvent = z.infer<typeof ChatEventSchema> | { type: "done" };

export function appendChatActivity(activity: ChatActivity[], event: ChatEvent): ChatActivity[] {
  if (event.type === "thinking") {
    const last = activity[activity.length - 1];
    if (last?.type === "thinking")
      return [...activity.slice(0, -1), { ...last, text: (last.text + event.text).slice(-100000) }];
    return [...activity, { type: "thinking", id: crypto.randomUUID(), text: event.text }].slice(
      -200,
    ) as ChatActivity[];
  }
  if (event.type === "tool_use")
    return [...activity, { type: "tool", ...event.data }].slice(-200) as ChatActivity[];
  if (event.type === "tool_result") {
    const existing = activity.some(
      (item) => item.type === "tool" && item.id === event.data.toolUseId,
    );
    const items = existing
      ? activity
      : [...activity, { type: "tool" as const, id: event.data.toolUseId, name: "Tool", input: "" }];
    return items
      .map((item) =>
        item.type === "tool" && item.id === event.data.toolUseId
          ? { ...item, result: event.data.content, isError: event.data.isError }
          : item,
      )
      .slice(-200);
  }
  if (event.type === "system_status")
    return [...activity, { type: "status", id: crypto.randomUUID(), text: event.text }].slice(
      -200,
    ) as ChatActivity[];
  return activity;
}
