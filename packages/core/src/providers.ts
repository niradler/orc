import { z } from "zod";
import { ChatModelSchema } from "./chat.js";
import { ChatAgentOptionsSchema, chatRuntime } from "./chat-options.js";
import { AGENT_ID_PATTERN } from "./coding-agents.js";

export const ProviderIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export function providerSecretName(name: string): boolean {
  return /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTHORIZATION)(?:_|$)/i.test(name);
}
export const ProviderEnvironmentSchema = z
  .array(
    z
      .object({
        name: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
          .refine(
            (name) =>
              !/^ORC_|^CLAUDECODE$|^CLAUDE_PID$|^CLAUDE_AGENT_SDK_|^CLAUDE_CODE_(?:ENTRYPOINT|CHILD_SESSION|SESSION_|HOST_SESSION_ID|MESSAGING_|SSE_PORT)|^(?:__proto__|constructor|prototype)$/i.test(
                name,
              ),
            "ORC connection and agent transport variables are managed by ORC",
          ),
        value: z
          .string()
          .max(8192)
          .refine((value) => !value.includes("\0"), "Environment values cannot contain NUL")
          .nullable(),
        secret: z.boolean().default(false),
      })
      .strict(),
  )
  .max(64)
  .superRefine((rows, context) => {
    const names = new Set<string>();
    for (const [index, row] of rows.entries()) {
      if (names.has(row.name.toLowerCase()))
        context.addIssue({
          code: "custom",
          path: [index, "name"],
          message: "Environment names must be unique",
        });
      names.add(row.name.toLowerCase());
      if (providerSecretName(row.name) && !row.secret)
        context.addIssue({
          code: "custom",
          path: [index, "secret"],
          message: "Credential variables must be stored as secrets",
        });
    }
  });
const AgentHomeSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (value) =>
      Array.from(value).every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
    "Use a directory path without control characters",
  )
  .refine(
    (value) => !value || /^(?:~[\\/]|[A-Za-z]:[\\/]|\\\\|\/)/.test(value),
    "Use an absolute path or one that starts with ~/",
  )
  .optional();
export const ProviderProfileSchema = z
  .object({
    id: ProviderIdSchema,
    name: z.string().trim().min(1).max(80),
    agent: z.string().regex(AGENT_ID_PATTERN),
    enabled: z.boolean(),
    executable: z
      .string()
      .trim()
      .max(2048)
      .refine(
        (value) =>
          Array.from(value).every(
            (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
          ),
        "Use an executable path without control characters",
      )
      .default(""),
    home: AgentHomeSchema,
    model: ChatModelSchema.default(""),
    options: ChatAgentOptionsSchema.optional(),
    environment: ProviderEnvironmentSchema.default([]),
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.options && profile.options.runtime !== chatRuntime(profile.agent))
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Launch options must match the selected adapter",
      });
    if (profile.executable && !["claude", "codex", "opencode", "pi"].includes(profile.agent))
      context.addIssue({
        code: "custom",
        path: ["executable"],
        message: "Configure other agent commands through acpx on the execution host",
      });
  });
export const ProviderSettingsSchema = z
  .object({
    providers: z.array(ProviderProfileSchema).min(1).max(64),
    default_provider_id: ProviderIdSchema,
    revision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((settings, context) => {
    if (new Set(settings.providers.map((profile) => profile.id)).size !== settings.providers.length)
      context.addIssue({
        code: "custom",
        path: ["providers"],
        message: "Provider IDs must be unique",
      });
    if (
      new Set(settings.providers.map((profile) => profile.name.toLowerCase())).size !==
      settings.providers.length
    )
      context.addIssue({
        code: "custom",
        path: ["providers"],
        message: "Provider names must be unique",
      });
    if (
      !settings.providers.some((profile) => profile.id === settings.default_provider_id) ||
      (settings.providers.some((profile) => profile.enabled) &&
        !settings.providers.some(
          (profile) => profile.id === settings.default_provider_id && profile.enabled,
        ))
    )
      context.addIssue({
        code: "custom",
        path: ["default_provider_id"],
        message: "Choose an enabled default provider",
      });
  });
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;
export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;
export type ProviderEnvironment = z.infer<typeof ProviderEnvironmentSchema>;

export const ProviderAccountSchema = z.object({
  provider_id: ProviderIdSchema,
  name: z.string(),
  agent: z.string(),
  home: z.string(),
  status: z.enum(["signed_in", "signed_out", "unknown"]),
  label: z.string().nullable(),
  organization: z.string().nullable(),
  plan: z.string().nullable(),
  duplicate_of: ProviderIdSchema.nullable(),
  message: z.string().nullable(),
  sign_in_command: z.string().nullable(),
});
export const ProviderAccountsSchema = z.object({ accounts: z.array(ProviderAccountSchema) });
export type ProviderAccount = z.infer<typeof ProviderAccountSchema>;
export type ProviderAccounts = z.infer<typeof ProviderAccountsSchema>;

const StoredProfileSchema = ProviderProfileSchema.safeExtend({
  environment: z
    .array(
      z
        .object({
          name: z.string(),
          value: z.string().max(50000),
          secret: z.boolean(),
        })
        .strict(),
    )
    .max(64)
    .default([]),
}).superRefine((profile, context) => {
  const result = ProviderEnvironmentSchema.safeParse(
    profile.environment.map((row) => ({
      ...row,
      value: row.secret ? null : row.value,
    })),
  );
  if (!result.success)
    for (const issue of result.error.issues)
      context.addIssue({
        code: "custom",
        path: ["environment", ...issue.path],
        message: issue.message,
      });
  if (
    profile.environment.some(
      (row) =>
        row.secret && !/^enc:v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]*$/.test(row.value),
    )
  )
    context.addIssue({
      code: "custom",
      path: ["environment"],
      message: "Provider secrets must be encrypted through provider settings",
    });
});
export const StoredProvidersSchema = z
  .object({
    instances: z.array(StoredProfileSchema).min(1).max(64),
    default_id: ProviderIdSchema,
  })
  .strict()
  .superRefine((stored, context) => {
    const result = ProviderSettingsSchema.safeParse({
      providers: stored.instances.map((profile) => ({
        ...profile,
        environment: profile.environment.map((row) => ({
          ...row,
          value: row.secret ? null : row.value,
        })),
      })),
      default_provider_id: stored.default_id,
      revision: "0".repeat(64),
    });
    if (!result.success)
      for (const issue of result.error.issues)
        context.addIssue({ code: "custom", path: issue.path, message: issue.message });
  });
export type StoredProviderProfile = z.infer<typeof StoredProvidersSchema>["instances"][number];
