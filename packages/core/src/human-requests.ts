import { z } from "zod";
import { ProjectSecretNameSchema, ProjectSecretRefSchema } from "./project-secrets.js";

export const SecretFieldSchema = z
  .object({
    key: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/),
    label: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(1000).optional(),
    required: z.boolean().default(true),
    multiline: z.boolean().default(false),
    link: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            (url.protocol === "https:" || url.protocol === "http:") &&
            !url.username &&
            !url.password
          );
        } catch {
          return false;
        }
      }, "Link must be an http(s) URL without embedded credentials")
      .optional(),
    reference_name: ProjectSecretNameSchema.optional(),
  })
  .strict();

export const SecretResponseSchema = z
  .object({
    kind: z.literal("secret"),
    stored: z.boolean(),
    references: z.record(z.string(), ProjectSecretRefSchema).optional(),
    delivered_fields: z.array(z.string()).default([]),
    consumed: z.boolean().default(false),
  })
  .strict();

export const SecretRespondPayloadSchema = z
  .object({
    kind: z.literal("secret"),
    values: z.record(z.string().min(1).max(64), z.string().max(16000)),
    save_to_project: z.boolean().default(false),
    reference_names: z.record(z.string().min(1).max(64), ProjectSecretNameSchema).optional(),
  })
  .strict();

export const CommandSpecSchema = z
  .object({
    script: z.string().trim().min(1).max(16000),
    cwd: z.string().trim().min(1).max(4096),
    host: z
      .string()
      .max(255)
      .regex(/^[A-Za-z0-9_.@][A-Za-z0-9_.@-]*$/)
      .nullable()
      .optional(),
    arguments: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
            label: z.string().trim().min(1).max(200),
            description: z.string().trim().min(1).max(1000).optional(),
            required: z.boolean().default(true),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    timeout_seconds: z.number().int().min(1).max(300).default(60),
  })
  .strict()
  .refine(
    (value) => new Set(value.arguments.map((arg) => arg.name)).size === value.arguments.length,
    "Argument names must be unique",
  );
export const CommandRunSchema = z
  .object({
    version: z.number().int().positive(),
    script: z.string().trim().min(1).max(16000),
    values: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.string().max(16000)),
  })
  .strict();
export const CommandResultSchema = z
  .object({
    kind: z.literal("command"),
    script: z.string().max(16000).optional(),
    exit_code: z.number().int(),
    stdout: z.string().max(64000),
    stderr: z.string().max(64000),
    truncated: z.boolean(),
  })
  .strict();

const identity = z.string().trim().min(1).max(128);
export const HumanRuleBindingSchema = z
  .object({ revision_id: identity, rule_id: identity, workspace: z.string().min(1).max(4096) })
  .strict();
export const HumanRequestInputSchema = z
  .object({
    origin: z
      .object({
        session_id: identity,
        backend: identity,
        request_id: identity,
        tool_call_id: identity.optional(),
        chat_thread_id: z.string().uuid().optional(),
        session_title: z.string().trim().min(1).max(200).optional(),
        native_session_id: identity.optional(),
        native_request_key: identity.optional(),
        execution_host: z.string().min(1).max(255).nullable().optional(),
        channel: z
          .object({
            connection: identity,
            target: identity,
            chat_id: identity,
            thread_id: identity.optional(),
            sender_id: identity,
          })
          .strict()
          .optional(),
      })
      .strict(),
    project_id: identity.nullable().default(null),
    rule_binding: HumanRuleBindingSchema.optional(),
    rule_bindings: z.array(HumanRuleBindingSchema).min(1).max(100).optional(),
    kind: z.enum(["question", "approval", "command", "secret"]),
    command: CommandSpecSchema.optional(),
    fields: z.array(SecretFieldSchema).min(1).max(10).optional(),
    save_to_project: z.boolean().optional(),
    title: z.string().trim().min(1).max(200).optional(),
    prompt: z.string().trim().min(1).max(16000),
    choices: z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
    choice_descriptions: z
      .record(z.string().min(1).max(1000), z.string().max(5000))
      .default({})
      .refine((value) => Object.keys(value).length <= 20, "Too many choice descriptions"),
    multi_select: z.boolean().default(false),
    notify: z
      .array(z.enum(["telegram", "slack", "slack-user"]))
      .max(2)
      .default([]),
    action: z
      .object({
        tool: identity,
        input: z.record(z.string(), z.unknown()),
        cwd: z.string().min(1).max(4096),
        host: z.string().min(1).max(128),
      })
      .strict()
      .optional(),
    /** Inline callers (MCP elicitation) consume the answer without a session turn. */
    deliver_to_session: z.boolean().default(true),
    expires_in_seconds: z.number().int().min(1).max(604800).default(86400),
  })
  .strict()
  .superRefine((input, context) => {
    if ((input.kind === "command") !== !!input.command)
      context.addIssue({
        code: "custom",
        message: "Command requests require a command specification",
      });
    if (input.kind === "command" && (input.action || input.choices.length || input.notify.length))
      context.addIssue({ code: "custom", message: "Command requests use the web Run action only" });
    if ((input.kind === "secret") !== !!input.fields)
      context.addIssue({
        code: "custom",
        message: "Secret requests require between 1 and 10 fields",
      });
    if (input.kind !== "secret" && input.save_to_project !== undefined)
      context.addIssue({
        code: "custom",
        message: "save_to_project is only valid for secret requests",
      });
    if (input.kind === "secret") {
      if (input.choices.length || input.multi_select || input.action || input.command)
        context.addIssue({
          code: "custom",
          message: "Secret requests cannot specify choices, multi_select, action, or command",
        });
      if (
        input.fields &&
        new Set(input.fields.map((field) => field.key)).size !== input.fields.length
      )
        context.addIssue({ code: "custom", message: "Secret field keys must be unique" });
    }
    if (input.rule_binding && input.rule_bindings)
      context.addIssue({ code: "custom", message: "Use one rule binding format" });
    if (input.kind === "approval" && !input.action)
      context.addIssue({
        code: "custom",
        message: "Approval requires the exact action, folder and host",
      });
    if (input.kind === "approval" && input.choices.length)
      context.addIssue({ code: "custom", message: "Approval uses approve or deny" });
    if (new Set(input.choices).size !== input.choices.length)
      context.addIssue({ code: "custom", message: "Choices must be unique" });
    if (Object.keys(input.choice_descriptions).some((choice) => !input.choices.includes(choice)))
      context.addIssue({
        code: "custom",
        message: "Descriptions must belong to a question choice",
      });
  });

const QuestionResponseSchema = z
  .object({
    kind: z.literal("question"),
    answer: z.string().trim().min(1).max(16000),
    selected_choices: z.array(z.string().min(1).max(1000)).min(1).max(20).optional(),
  })
  .strict();

const ApprovalResponseSchema = z
  .object({ kind: z.literal("approval"), approved: z.boolean() })
  .strict();

export const HumanResponseSchema = z.discriminatedUnion("kind", [
  CommandResultSchema,
  QuestionResponseSchema,
  ApprovalResponseSchema,
  SecretResponseSchema,
]);
export const HumanRespondPayloadSchema = z.discriminatedUnion("kind", [
  QuestionResponseSchema,
  ApprovalResponseSchema,
  SecretRespondPayloadSchema,
]);

export const MAX_SNOOZE_SECONDS = 365 * 86400;
const MAX_EPOCH_MS = 8_640_000_000_000_000;

export const HumanRequestSnoozeSchema = z
  .object({
    version: z.number().int().positive(),
    until: z.number().int().positive().max(MAX_EPOCH_MS).optional(),
    after_seconds: z.number().int().min(1).max(MAX_SNOOZE_SECONDS).optional(),
  })
  .strict()
  .refine(
    (value) => (value.until !== undefined) !== (value.after_seconds !== undefined),
    "Supply either until or after_seconds",
  );
export const HumanRequestSchema = z.object({
  id: identity,
  input: HumanRequestInputSchema,
  status: z.enum([
    "pending",
    "running",
    "answered",
    "delivered",
    "cancelled",
    "expired",
    "unavailable",
  ]),
  delivery_error: z.string().nullable().default(null),
  version: z.number().int().positive(),
  response: HumanResponseSchema.nullable(),
  created_at: z.number(),
  expires_at: z.number(),
  responded_at: z.number().nullable(),
  delivered_at: z.number().nullable(),
  seen_at: z.number().nullable().default(null),
  snooze_until: z.number().nullable().default(null),
  push_state: z.enum(["pushing", "pushed", "failed", "interrupted"]).nullable().default(null),
  push_error: z.string().nullable().default(null),
});

export const SecretClaimResultSchema = z
  .object({
    request: HumanRequestSchema,
    secret: z.literal(true),
    consumed: z.boolean(),
    stored: z.boolean(),
    values: z.record(z.string(), z.string()).optional(),
    references: z.record(z.string(), ProjectSecretRefSchema).optional(),
  })
  .strict();

export type SecretField = z.infer<typeof SecretFieldSchema>;
export type SecretResponse = z.infer<typeof SecretResponseSchema>;
export type SecretRespondPayload = z.infer<typeof SecretRespondPayloadSchema>;
export type HumanRespondPayload = z.infer<typeof HumanRespondPayloadSchema>;
export type HumanRequestInput = z.infer<typeof HumanRequestInputSchema>;
export type HumanResponse = z.infer<typeof HumanResponseSchema>;
export type HumanRequestSnoozeInput = z.infer<typeof HumanRequestSnoozeSchema>;
export type HumanRequest = z.infer<typeof HumanRequestSchema>;
export type SecretClaimResult = z.infer<typeof SecretClaimResultSchema>;

const DURATION_UNITS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

export function parseSnoozeDurationSeconds(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (!value || !/^(?:\d+[smhd])+$/.test(value)) return null;
  let total = 0;
  for (const match of value.matchAll(/(\d+)([smhd])/g)) {
    const amount = Number(match[1]);
    const unit = DURATION_UNITS[match[2] ?? ""];
    if (!Number.isSafeInteger(amount) || !unit) return null;
    total += amount * unit;
  }
  if (total < 1 || total > MAX_SNOOZE_SECONDS) return null;
  return total;
}
