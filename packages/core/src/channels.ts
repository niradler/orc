import { z } from "zod";

export const ChannelProviderSchema = z.enum(["telegram", "slack"]);
export const ChannelBuiltinCommands = [
  { command: "help", description: "Chat controls and custom shortcuts" },
  { command: "status", description: "Current project, agent, model and session" },
  { command: "projects", description: "Select a project and its working folder" },
  { command: "project", description: "Select a project (alias for /projects)" },
  { command: "agent", description: "Select an agent or restore the default" },
  { command: "model", description: "Select a model or restore the default" },
  { command: "session", description: "New, list, switch or stop a conversation" },
  { command: "session_new", description: "Start a new conversation" },
  { command: "session_list", description: "Choose a conversation" },
  { command: "stop", description: "Stop the current turn and queued messages" },
] as const;
export const ChannelCommandsSchema = z
  .array(
    z
      .object({
        command: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
        description: z.string().trim().min(1).max(100),
        prompt: z.string().trim().min(1).max(10000),
      })
      .strict(),
  )
  .max(50)
  .superRefine((commands, ctx) => {
    const names = commands.map((c) => c.command);
    if (
      new Set(names).size !== names.length ||
      names.some(
        (name) =>
          ["start", "orc", "projects", "sessions"].includes(name) ||
          ChannelBuiltinCommands.some((c) => c.command === name),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Command names must be unique and cannot replace ORC controls",
      });
  });
export function channelCommands(config: Record<string, unknown>) {
  return ChannelCommandsSchema.parse(config.commands ?? []);
}
export function channelCommand(text: string): { name: string; args: string } | null {
  let source = text.trim();
  const slack = source.match(/^\/orc(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (slack) source = `/${(slack[1]?.trim() || "help").replace(/^\//, "")}`;
  const match = source.match(/^\/([a-z][a-z0-9_]*)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!match || match[1]?.toLowerCase() === "orc") return null;
  const name = (match[1] ?? "").toLowerCase();
  const args = match[2]?.trim() ?? "";
  if (!args && (name === "session_new" || name === "session_list"))
    return { name: "session", args: name === "session_new" ? "new" : "list" };
  return { name, args };
}
export type ChannelProviderInfo = {
  id: "telegram" | "slack";
  name: string;
  credentials: { key: string; label: string; env: string }[];
  documentation: string;
  capabilities: Record<string, boolean>;
  setup: string[];
};
export type ChannelPairingView = {
  id: string;
  connection: string;
  expires_at: number;
  candidate: { chat_id: string; user_id: string; name: string } | null;
  confirmed: boolean;
};
const key = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
function boundedJson(value: unknown, depth = 0, budget = { nodes: 0 }): boolean {
  if (depth > 20 || ++budget.nodes > 10000) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 100000;
  if (Array.isArray(value)) return value.every((item) => boundedJson(item, depth + 1, budget));
  if (typeof value === "object")
    return Object.entries(value).every(
      ([key, item]) =>
        !["__proto__", "prototype", "constructor"].includes(key) &&
        boundedJson(item, depth + 1, budget),
    );
  return false;
}
const native = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => boundedJson(value) && JSON.stringify(value).length <= 262144,
    "Native payload must be bounded JSON (256 KB, depth 20)",
  );
export const ChannelFields = [
  "sender",
  "chat",
  "thread",
  "text",
  "command",
  "is_direct",
  "is_mention",
  "kind",
] as const;
export const ChannelOperators = ["is", "in", "contains", "starts_with"] as const;
export type ChannelCondition =
  | { always: true }
  | {
      field: (typeof ChannelFields)[number];
      op: (typeof ChannelOperators)[number];
      value: string | boolean | string[];
    }
  | { all: ChannelCondition[] }
  | { any: ChannelCondition[] }
  | { not: ChannelCondition };

export function isChannelCatchAll(input: unknown): input is { always: true } {
  return (
    !!input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.keys(input).length === 1 &&
    "always" in input &&
    input.always === true
  );
}

export function validChannelCondition(
  input: unknown,
  depth = 0,
  budget = { nodes: 0 },
): input is ChannelCondition {
  if (
    depth > 5 ||
    ++budget.nodes > 100 ||
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  )
    return false;
  const item = input as Record<string, unknown>;
  const keys = Object.keys(item);
  if (keys.length === 1) {
    if ("always" in item) return depth === 0 && item.always === true;
    if ("not" in item) return validChannelCondition(item.not, depth + 1, budget);
    const children = item.all ?? item.any;
    return (
      ("all" in item || "any" in item) &&
      Array.isArray(children) &&
      children.length > 0 &&
      children.every((child) => validChannelCondition(child, depth + 1, budget))
    );
  }
  if (keys.length !== 3 || !keys.every((k) => ["field", "op", "value"].includes(k))) return false;
  if (
    !(ChannelFields as readonly unknown[]).includes(item.field) ||
    !(ChannelOperators as readonly unknown[]).includes(item.op)
  )
    return false;
  if (item.op === "in")
    return (
      Array.isArray(item.value) &&
      item.value.length > 0 &&
      item.value.length <= 100 &&
      item.value.every((v) => typeof v === "string" && v.length <= 1000)
    );
  if (item.op !== "is")
    return typeof item.value === "string" && item.value.length > 0 && item.value.length <= 1000;
  return (
    typeof item.value === "boolean" || (typeof item.value === "string" && item.value.length <= 1000)
  );
}

export const ChannelRouteSchema = z
  .object({
    id: key,
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean().default(true),
    condition: z
      .unknown()
      .refine(
        (value): boolean => validChannelCondition(value),
        "Use field/op/value, nonempty all/any/not groups (maximum depth 5 and 100 conditions), or a top-level always:true fallback",
      ),
    action: z.discriminatedUnion("type", [
      z.object({ type: z.literal("ignore") }).strict(),
      z
        .object({
          type: z.literal("agent"),
          agent: z
            .string()
            .trim()
            .min(1)
            .max(100)
            .regex(/^[a-z][a-z0-9_-]*$/),
          profile: z.string().min(1).max(100).optional(),
          model: z
            .string()
            .trim()
            .min(1)
            .max(200)
            .regex(/^[a-z0-9][a-z0-9._:/@+-]*$/i)
            .optional(),
          project_id: z.string().min(1).max(100),
        })
        .strict(),
    ]),
  })
  .strict();

export const ChannelTargetSchema = z
  .object({
    id: key,
    name: z.string().trim().min(1).max(100),
    chat_id: z.string().trim().min(1).max(200),
    thread_id: z.string().trim().min(1).max(200).optional(),
    user_ids: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
    project_ids: z.array(z.string().min(1).max(100)).max(100).default([]),
    inbound: z.boolean().default(false),
    outbound: z.boolean().default(true),
    attention: z.boolean().default(false),
  })
  .strict();

export const ChannelConnectionSchema = z
  .object({
    id: key,
    name: z.string().trim().min(1).max(100),
    provider: ChannelProviderSchema,
    enabled: z.boolean().default(false),
    revision: z.number().int().min(0).default(0),
    config: native.default({}),
    credentials: z.record(z.string(), z.string().max(10000)).default({}),
    targets: z.array(ChannelTargetSchema).max(100).default([]),
    routes: z.array(ChannelRouteSchema).max(100).default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    const commands = ChannelCommandsSchema.safeParse(v.config.commands ?? []);
    if (!commands.success)
      ctx.addIssue({
        code: "custom",
        message: commands.error.message,
        path: ["config", "commands"],
      });
    for (const field of ["targets", "routes"] as const) {
      if (new Set(v[field].map((x) => x.id)).size !== v[field].length)
        ctx.addIssue({ code: "custom", message: `Duplicate ${field} IDs`, path: [field] });
    }
    if (
      v.routes.some(
        (route, index) => isChannelCatchAll(route.condition) && index !== v.routes.length - 1,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "The Otherwise rule must be last; only one is allowed",
        path: ["routes"],
      });
  });

export const ChannelSaveSchema = ChannelConnectionSchema;
export const ChannelMessageSchema = z
  .object({
    text: z.string().min(1).max(100000),
    format: z.enum(["markdown", "plain"]).default("markdown"),
    links: z
      .array(
        z
          .object({ label: z.string().min(1).max(100), url: z.url().regex(/^https?:\/\//) })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();
export const ChannelSendSchema = z
  .object({
    connection: key,
    target: key,
    message: ChannelMessageSchema,
    overrides: native
      .optional()
      .describe(
        "Native provider message payload. All message fields pass through; explicit fields replace generated fields. Credentials and destination are controlled by ORC.",
      ),
    project_id: z.string().min(1).max(100).nullable().optional(),
    idempotency_key: z.string().min(1).max(200).optional(),
    thread_id: z.string().min(1).max(200).optional(),
  })
  .strict();
export const ChannelUpdateSchema = ChannelSendSchema.omit({
  connection: true,
  target: true,
  idempotency_key: true,
});
export const ChannelViewSchema = z.object({
  id: key,
  name: z.string(),
  provider: ChannelProviderSchema,
  enabled: z.boolean(),
  revision: z.number().int(),
  config: native,
  targets: z.array(ChannelTargetSchema),
  routes: z.array(ChannelRouteSchema),
  credentials: z.record(
    z.string(),
    z.object({ configured: z.boolean(), source: z.enum(["environment", "stored", "missing"]) }),
  ),
  identity: z.object({ id: z.string(), name: z.string() }).nullable(),
  status: z.enum(["disabled", "setup", "ready", "error"]),
  error: z.string().nullable(),
});
export type ChannelView = z.infer<typeof ChannelViewSchema>;
export const ChannelReceiptSchema = z.object({
  id: z.string(),
  connection: z.string(),
  target: z.string(),
  project_id: z.string().nullable(),
  status: z.enum(["sending", "accepted", "failed", "unknown", "partial"]),
  provider_ids: z.array(z.string()),
  destination: z.object({ chat_id: z.string(), thread_id: z.string().optional() }).optional(),
  error: z.string().nullable(),
  created_at: z.number(),
});
export type ChannelConnection = z.infer<typeof ChannelConnectionSchema>;
export type ChannelTarget = z.infer<typeof ChannelTargetSchema>;
export type ChannelRoute = z.infer<typeof ChannelRouteSchema>;
export type ChannelMessage = z.infer<typeof ChannelMessageSchema>;
export type ChannelSend = z.infer<typeof ChannelSendSchema>;
export type ChannelReceipt = z.infer<typeof ChannelReceiptSchema>;
export type ChannelInbound = {
  attachments?: { fileId: string; name: string; mimeType: string; size?: number }[];
  connection: string;
  sender: string;
  chat: string;
  thread?: string | undefined;
  text: string;
  message_id: string;
  kind: "message" | "action";
  is_direct: boolean;
  is_mention: boolean;
};
