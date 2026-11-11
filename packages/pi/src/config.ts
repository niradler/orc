import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { DEFAULT_RECALL, type RecallOptions } from "./recall.js";

export const PORC_CONFIG_NAME = "porc.json";
export const DEFAULT_API_BASE = "http://127.0.0.1:7700";

const BooleanString = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.enum(["1", "true", "yes", "on", "0", "false", "no", "off"]))
  .transform((value) => ["1", "true", "yes", "on"].includes(value));

const HttpUrl = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, "Use an http:// or https:// URL");

const RecallSettings = z
  .object({
    enabled: z.boolean().optional(),
    maxSkills: z.number().int().min(0).max(10).optional(),
    maxMemories: z.number().int().min(0).max(10).optional(),
    minSkillScore: z.number().min(0).max(100).optional(),
    budgetChars: z.number().int().min(200).max(4000).optional(),
  })
  .strict();

export const PorcFileSchema = z
  .object({
    enabled: z.boolean().optional(),
    apiBase: HttpUrl.optional(),
    secretEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "Use an environment variable name")
      .optional(),
    transport: z.enum(["stdio", "http"]).optional(),
    project: z.string().trim().min(1).max(100).optional(),
    autoProject: z.boolean().optional(),
    askProject: z.boolean().optional(),
    autoContext: z.boolean().optional(),
    systemPrompt: z.boolean().optional(),
    rules: z.boolean().optional(),
    timeoutMs: z.number().int().min(250).max(60_000).optional(),
    command: z.string().trim().min(1).max(2048).optional(),
    recall: RecallSettings.optional(),
  })
  .strict();

export type PorcFile = z.infer<typeof PorcFileSchema>;

const OrcFileSchema = z
  .object({
    api: z
      .object({
        host: z.string().optional(),
        port: z.number().int().min(1).max(65_535).optional(),
        secret: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

export type SecretSource = "env" | "file" | "orc";

export type PorcConfig = {
  enabled: boolean;
  apiBase: string;
  secret?: string;
  secretSource?: SecretSource;
  transport: "stdio" | "http";
  project?: string;
  autoProject: boolean;
  askProject: boolean;
  autoContext: boolean;
  systemPrompt: boolean;
  rules: boolean;
  timeoutMs: number;
  command: string;
  recall: RecallOptions & { enabled: boolean };
};

export type PorcOverrides = {
  apiBase?: string;
  project?: string;
  autoContext?: boolean;
  recall?: boolean;
  rules?: boolean;
};

export type LoadConfigOptions = {
  cwd: string;
  env?: Record<string, string | undefined>;
  home?: string;
  projectTrusted?: boolean;
  overrides?: PorcOverrides;
};

export class PorcConfigError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "PorcConfigError";
  }
}

export function porcPaths(options: { cwd: string; home?: string }): {
  userFile: string;
  projectFile: string;
  orcFile: string;
  choicesFile: string;
} {
  const home = options.home ?? homedir();
  return {
    userFile: join(home, ".pi", "agent", PORC_CONFIG_NAME),
    projectFile: join(options.cwd, ".pi", PORC_CONFIG_NAME),
    orcFile: join(home, ".orc", "config.json"),
    choicesFile: join(home, ".pi", "agent", "porc-projects.json"),
  };
}

function readJson(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new PorcConfigError(
      path,
      `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function readPorcFile(path: string): PorcFile {
  if (!existsSync(path)) return {};
  const parsed = PorcFileSchema.safeParse(readJson(path));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new PorcConfigError(path, detail);
  }
  return parsed.data;
}

function readOrcApi(path: string): { host?: string; port?: number; secret?: string } {
  if (!existsSync(path)) return {};
  let value: unknown;
  try {
    value = readJson(path);
  } catch {
    return {};
  }
  const parsed = OrcFileSchema.safeParse(value);
  if (!parsed.success) return {};
  const api = parsed.data.api ?? {};
  return {
    ...(api.host ? { host: api.host } : {}),
    ...(api.port ? { port: api.port } : {}),
    ...(api.secret?.trim() ? { secret: api.secret.trim() } : {}),
  };
}

export function normalizeApiBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new PorcConfigError("apiBase", `Invalid URL "${value}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new PorcConfigError("apiBase", "Use an http:// or https:// URL");
  const host = ["0.0.0.0", "::", "[::]"].includes(url.hostname) ? "127.0.0.1" : url.hostname;
  const port = url.port ? `:${url.port}` : "";
  const path = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/api$/, "")
    .replace(/\/+$/, "");
  return `${url.protocol}//${host}${port}${path}`;
}

export function resolveApiBase(input: {
  configured?: string;
  env?: string | undefined;
  orc?: { host?: string; port?: number };
}): string {
  const explicit = input.env?.trim() || input.configured?.trim();
  if (explicit) return normalizeApiBase(explicit);
  const orc = input.orc ?? {};
  const host =
    !orc.host || ["0.0.0.0", "::", "[::]", ""].includes(orc.host) ? "127.0.0.1" : orc.host;
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${bracketed}:${orc.port ?? 7700}`;
}

function bool(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = BooleanString.safeParse(value);
  if (!parsed.success) throw new PorcConfigError(name, `Expected a boolean, got "${value}"`);
  return parsed.data;
}

function transport(value: string | undefined): "stdio" | "http" | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (value === "stdio" || value === "http") return value;
  throw new PorcConfigError("PORC_MCP_TRANSPORT", `Expected stdio or http, got "${value}"`);
}

function timeout(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 250 || parsed > 60_000)
    throw new PorcConfigError("PORC_TIMEOUT_MS", "Expected an integer between 250 and 60000");
  return parsed;
}

function stringEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function pickSecret(
  env: Record<string, string | undefined>,
  file: PorcFile,
  orc: { secret?: string },
): { secret?: string; source?: SecretSource } {
  const primary = stringEnv(env, "PORC_API_SECRET");
  if (primary) return { secret: primary, source: "env" };
  const named = file.secretEnv ? stringEnv(env, file.secretEnv) : undefined;
  if (named) return { secret: named, source: "file" };
  const inherited = stringEnv(env, "ORC_API_SECRET");
  if (inherited) return { secret: inherited, source: "env" };
  if (orc.secret) return { secret: orc.secret, source: "orc" };
  return {};
}

export function loadPorcConfig(options: LoadConfigOptions): PorcConfig {
  const cwd = resolve(options.cwd);
  const home = options.home ?? homedir();
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const overrides = options.overrides ?? {};
  const paths = porcPaths({ cwd, home });
  const user = readPorcFile(paths.userFile);
  const project = options.projectTrusted ? readPorcFile(paths.projectFile) : {};
  const file = { ...user, ...project, recall: { ...user.recall, ...project.recall } };
  const orc = readOrcApi(paths.orcFile);
  const envBase = stringEnv(env, "PORC_API_BASE") ?? stringEnv(env, "ORC_API_BASE");

  const config: PorcConfig = {
    enabled: bool(stringEnv(env, "PORC_DISABLED"), "PORC_DISABLED")
      ? false
      : (file.enabled ?? true),
    apiBase: overrides.apiBase
      ? normalizeApiBase(overrides.apiBase)
      : resolveApiBase({
          ...(file.apiBase ? { configured: file.apiBase } : {}),
          ...(envBase ? { env: envBase } : {}),
          orc,
        }),
    transport: transport(stringEnv(env, "PORC_MCP_TRANSPORT")) ?? file.transport ?? "stdio",
    autoProject:
      bool(stringEnv(env, "PORC_AUTO_PROJECT"), "PORC_AUTO_PROJECT") ?? file.autoProject ?? true,
    askProject:
      bool(stringEnv(env, "PORC_ASK_PROJECT"), "PORC_ASK_PROJECT") ?? file.askProject ?? true,
    autoContext:
      overrides.autoContext ??
      bool(stringEnv(env, "PORC_CONTEXT"), "PORC_CONTEXT") ??
      file.autoContext ??
      true,
    systemPrompt:
      bool(stringEnv(env, "PORC_SYSTEM_PROMPT"), "PORC_SYSTEM_PROMPT") ?? file.systemPrompt ?? true,
    rules:
      overrides.rules ?? bool(stringEnv(env, "PORC_RULES"), "PORC_RULES") ?? file.rules ?? true,
    timeoutMs: timeout(stringEnv(env, "PORC_TIMEOUT_MS")) ?? file.timeoutMs ?? 5000,
    command: stringEnv(env, "PORC_ORC_COMMAND") ?? file.command ?? "orc",
    recall: {
      enabled:
        overrides.recall ??
        bool(stringEnv(env, "PORC_RECALL"), "PORC_RECALL") ??
        file.recall.enabled ??
        true,
      maxSkills: file.recall.maxSkills ?? DEFAULT_RECALL.maxSkills,
      maxMemories: file.recall.maxMemories ?? DEFAULT_RECALL.maxMemories,
      minSkillScore: file.recall.minSkillScore ?? DEFAULT_RECALL.minSkillScore,
      budgetChars: file.recall.budgetChars ?? DEFAULT_RECALL.budgetChars,
    },
  };
  const picked = pickSecret(env, file, orc);
  if (picked.secret) {
    config.secret = picked.secret;
    if (picked.source) config.secretSource = picked.source;
  }
  const projectName = overrides.project?.trim() || stringEnv(env, "PORC_PROJECT") || file.project;
  if (projectName) config.project = projectName;
  return config;
}

export function projectArgs(project: string | undefined): Record<string, string> {
  return project ? { project } : {};
}
