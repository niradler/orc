import { z } from "zod";

export const CHAT_SYSTEM_PROMPT =
  "You are an AI assistant integrated into the ORC orchestration hub. Help users manage tasks, review agent activity, and answer questions about the system. Use ORC tools for current workspace facts. Ask before destructive actions or publishing.";
export const ChatModelSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^$|^[a-z0-9][a-z0-9._:/@+-]*$/i);
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
    mcp: z.enum(["orc", "native"]).default("orc"),
  })
  .strict();
export type ChatSettings = z.infer<typeof ChatSettingsSchema>;
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
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export const ChatThreadSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  config: ChatSettingsSchema,
  cwd: z.string(),
  host: z.string().nullable(),
  runtimeId: z.string().nullable(),
  backend: z.string(),
  sourceId: z.string().nullable(),
  messages: z.array(ChatMessageSchema),
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
  z.object({ type: z.literal("thread"), thread: ChatThreadSchema, runId: z.string().uuid() }),
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
