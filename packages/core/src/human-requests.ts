import { z } from "zod";

export const CommandSpecSchema = z
  .object({
    script: z.string().trim().min(1).max(16000),
    cwd: z.string().trim().min(1).max(4096),
    host: z
      .string()
      .max(255)
      .regex(/^[A-Za-z0-9_.@][A-Za-z0-9_.@-]*$/)
      .nullable(),
    arguments: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
            label: z.string().trim().min(1).max(200),
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
    kind: z.enum(["question", "approval", "command"]),
    command: CommandSpecSchema.optional(),
    prompt: z.string().trim().min(1).max(16000),
    choices: z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
    choice_descriptions: z
      .record(z.string().min(1).max(1000), z.string().max(5000))
      .default({})
      .refine((value) => Object.keys(value).length <= 20, "Too many choice descriptions"),
    multi_select: z.boolean().default(false),
    notify: z
      .array(z.enum(["telegram", "slack"]))
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

export const HumanResponseSchema = z.discriminatedUnion("kind", [
  CommandResultSchema,
  z
    .object({
      kind: z.literal("question"),
      answer: z.string().trim().min(1).max(16000),
      selected_choices: z.array(z.string().min(1).max(1000)).min(1).max(20).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("approval"), approved: z.boolean() }).strict(),
]);
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
});
export type HumanRequestInput = z.infer<typeof HumanRequestInputSchema>;
export type HumanResponse = z.infer<typeof HumanResponseSchema>;
export type HumanRequest = z.infer<typeof HumanRequestSchema>;
