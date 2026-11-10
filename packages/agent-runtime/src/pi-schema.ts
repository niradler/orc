import { z } from "zod";

export const stateSchema = z.object({
  sessionId: z.uuid(),
  isStreaming: z.boolean(),
  isCompacting: z.boolean(),
  pendingMessageCount: z.number().int().nonnegative(),
  sessionFile: z.string().min(1).max(4096).optional(),
});
const contentSchema = z.array(
  z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
);
export const eventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message_update"),
    assistantMessageEvent: z.object({ type: z.string(), delta: z.string().optional() }),
  }),
  z.object({
    type: z.literal("message_end"),
    message: z
      .object({
        role: z.string(),
        stopReason: z.string().optional(),
        errorMessage: z.string().optional(),
        usage: z.unknown().optional(),
      })
      .passthrough(),
  }),
  z.object({
    type: z.literal("tool_execution_start"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown(),
  }),
  z.object({
    type: z.literal("tool_execution_update"),
    toolCallId: z.string(),
    partialResult: z.object({ content: contentSchema }).passthrough(),
  }),
  z.object({
    type: z.literal("tool_execution_end"),
    toolCallId: z.string(),
    result: z.object({ content: contentSchema }).passthrough(),
    isError: z.boolean(),
  }),
  z.object({ type: z.literal("agent_settled"), aborted: z.boolean() }),
  z
    .object({
      type: z.enum(["auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end"]),
    })
    .passthrough(),
]);
export const dialogSchema = z.discriminatedUnion("method", [
  z.object({
    type: z.literal("extension_ui_request"),
    id: z.string(),
    method: z.literal("select"),
    title: z.string(),
    options: z.array(z.string()).max(50),
    timeout: z.number().positive().optional(),
  }),
  z.object({
    type: z.literal("extension_ui_request"),
    id: z.string(),
    method: z.literal("confirm"),
    title: z.string(),
    message: z.string(),
    timeout: z.number().positive().optional(),
  }),
  z.object({
    type: z.literal("extension_ui_request"),
    id: z.string(),
    method: z.enum(["input", "editor"]),
    title: z.string(),
    placeholder: z.string().optional(),
    prefill: z.string().optional(),
    timeout: z.number().positive().optional(),
  }),
  z.object({
    type: z.literal("extension_ui_request"),
    id: z.string(),
    method: z.literal("notify"),
    message: z.string(),
    notifyType: z.enum(["info", "warning", "error"]).default("info"),
  }),
  z.object({
    type: z.literal("extension_ui_request"),
    id: z.string(),
    method: z.literal("setStatus"),
    statusKey: z.string(),
    statusText: z.string().optional(),
  }),
  z.object({
    type: z.literal("extension_ui_request"),
    id: z.string(),
    method: z.literal("setWidget"),
    widgetKey: z.string(),
    widgetLines: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("extension_ui_request"),
    id: z.string(),
    method: z.literal("setTitle"),
    title: z.string(),
  }),
  z.object({
    type: z.literal("extension_ui_request"),
    id: z.string(),
    method: z.literal("set_editor_text"),
    text: z.string(),
  }),
]);
