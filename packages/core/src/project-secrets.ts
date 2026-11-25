import { z } from "zod";

export const PROJECT_SECRET_REF_PREFIX = "project/";
export const PROJECT_SECRET_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const PROJECT_SECRET_REF_REGEX = /^project\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const SECRET_ENV_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const ProjectSecretNameSchema = z
  .string()
  .regex(
    PROJECT_SECRET_NAME_REGEX,
    "Secret name must start with a letter or number and use only letters, numbers, '.', '_' or '-'",
  );

export const ProjectSecretRefSchema = z
  .string()
  .regex(PROJECT_SECRET_REF_REGEX, "Project secret reference must use project/<name>");

export const SecretEnvNameSchema = z
  .string()
  .regex(SECRET_ENV_NAME_REGEX, "Environment variable name must be a valid identifier")
  .refine((value) => !value.toUpperCase().startsWith("ORC_"), "ORC_ variables are reserved");

export const SecretRefsMapSchema = z
  .record(SecretEnvNameSchema, ProjectSecretRefSchema)
  .refine((value) => Object.keys(value).length <= 50, "At most 50 secret references allowed");

export function formatProjectSecretRef(name: string): string {
  return `${PROJECT_SECRET_REF_PREFIX}${name}`;
}

export function parseProjectSecretRef(value: string): string | null {
  if (!PROJECT_SECRET_REF_REGEX.test(value)) return null;
  return value.slice(PROJECT_SECRET_REF_PREFIX.length);
}

export function defaultProjectSecretName(fieldKey: string): string {
  const cleaned = fieldKey
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  return cleaned || "secret";
}

const httpCheckUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        !parsed.username &&
        !parsed.password
      );
    } catch {
      return false;
    }
  }, "Check URL must be an http(s) URL without embedded credentials");

export const ProjectSecretHttpCheckSchema = z
  .object({
    type: z.literal("http"),
    url: httpCheckUrlSchema,
    method: z.enum(["GET", "HEAD", "POST"]).default("GET"),
    header_name: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9-]+$/, "Header name must contain only HTTP token characters")
      .default("Authorization"),
    value_prefix: z.string().max(64).default("Bearer "),
    expected_status: z.array(z.number().int().min(100).max(599)).min(1).max(10).optional(),
    timeout_seconds: z.number().int().min(1).max(30).default(10),
  })
  .strict();

export const ProjectSecretCommandCheckSchema = z
  .object({
    type: z.literal("command"),
    script: z.string().trim().min(1).max(4000),
    env_name: z
      .string()
      .regex(SECRET_ENV_NAME_REGEX, "Environment variable name must be a valid identifier")
      .default("ORC_SECRET_VALUE"),
    cwd: z.string().trim().min(1).max(4096).optional(),
    host: z
      .string()
      .max(255)
      .regex(/^[A-Za-z0-9_.@][A-Za-z0-9_.@-]*$/)
      .nullable()
      .optional(),
    timeout_seconds: z.number().int().min(1).max(60).default(15),
  })
  .strict();

export const ProjectSecretCheckSchema = z.discriminatedUnion("type", [
  ProjectSecretHttpCheckSchema,
  ProjectSecretCommandCheckSchema,
]);

export const ProjectSecretMetadataSchema = z
  .object({
    id: z.string(),
    project_id: z.string(),
    name: ProjectSecretNameSchema,
    reference: ProjectSecretRefSchema,
    description: z.string().nullable(),
    check: ProjectSecretCheckSchema.nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    last_used_at: z.string().datetime().nullable(),
  })
  .strict();

export const ProjectSecretUpsertSchema = z
  .object({
    name: ProjectSecretNameSchema,
    value: z.string().min(1).max(16000),
    description: z.string().trim().max(500).nullable().optional(),
    check: ProjectSecretCheckSchema.nullable().optional(),
  })
  .strict();

export const ProjectSecretRotateSchema = z
  .object({
    value: z.string().min(1).max(16000).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    check: ProjectSecretCheckSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.value !== undefined || input.description !== undefined || input.check !== undefined,
    "Provide a new value, description, or check configuration",
  );

export const ProjectSecretCheckResultSchema = z
  .object({
    ok: z.boolean(),
    reference: ProjectSecretRefSchema,
    mode: z.enum(["stored", "http", "command"]),
    status: z.number().int().nullable(),
    message: z.string(),
    checked_at: z.string().datetime(),
  })
  .strict();

export type ProjectSecretCheck = z.infer<typeof ProjectSecretCheckSchema>;
export type ProjectSecretMetadata = z.infer<typeof ProjectSecretMetadataSchema>;
export type ProjectSecretUpsert = z.infer<typeof ProjectSecretUpsertSchema>;
export type ProjectSecretRotate = z.infer<typeof ProjectSecretRotateSchema>;
export type ProjectSecretCheckResult = z.infer<typeof ProjectSecretCheckResultSchema>;
