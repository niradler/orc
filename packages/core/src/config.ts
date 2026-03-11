import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const BridgePlatformConfigSchema = z.object({
  enabled: z.boolean().default(false),
  token: z.string().optional(),
  authorized_users: z.array(z.union([z.string(), z.number()])).default([]),
  mode: z.enum(["direct", "agent:claude", "agent:codex"]).default("direct"),
});

export const OrcConfigSchema = z.object({
  db: z
    .object({
      path: z.string().default("~/.orc/orc.db"),
    })
    .default({}),

  api: z
    .object({
      port: z.number().int().default(7700),
      host: z.string().default("127.0.0.1"),
      secret: z.string().optional(),
    })
    .default({}),

  mcp: z
    .object({
      transport: z.enum(["stdio", "http"]).default("stdio"),
      port: z.number().int().default(7701),
    })
    .default({}),

  bridge: z
    .object({
      telegram: BridgePlatformConfigSchema.default({}),
      discord: BridgePlatformConfigSchema.default({}),
    })
    .default({}),

  runner: z
    .object({
      default_timeout_secs: z.number().int().default(300),
      max_concurrent_jobs: z.number().int().default(5),
      log_retention_days: z.number().int().default(30),
    })
    .default({}),

  context: z
    .object({
      snapshot_max_bytes: z.number().int().default(2048),
      layer1_task_limit: z.number().int().default(10),
      layer1_memory_limit: z.number().int().default(5),
    })
    .default({}),
});

export type OrcConfig = z.infer<typeof OrcConfigSchema>;
export type BridgePlatformConfig = z.infer<typeof BridgePlatformConfigSchema>;

function resolvePath(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function loadJsonFile(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof result[k] === "object" &&
      result[k] !== null
    ) {
      result[k] = deepMerge(result[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result;
}

function fromEnv(): Record<string, unknown> {
  const env: Record<string, unknown> = {};
  if (process.env.ORC_DB_PATH) env.db = { path: process.env.ORC_DB_PATH };
  if (process.env.ORC_API_PORT) env.api = { port: Number(process.env.ORC_API_PORT) };
  if (process.env.ORC_API_SECRET)
    env.api = { ...(env.api as object), secret: process.env.ORC_API_SECRET };
  if (process.env.ORC_TELEGRAM_TOKEN) {
    env.bridge = { telegram: { token: process.env.ORC_TELEGRAM_TOKEN, enabled: true } };
  }
  return env;
}

let _config: OrcConfig | null = null;

export function loadConfig(overrides?: Partial<OrcConfig>): OrcConfig {
  if (_config && !overrides) return _config;

  const globalConfigPath = join(homedir(), ".orc", "config.json");
  const localConfigPath = join(process.cwd(), ".orc", "config.json");

  let raw: Record<string, unknown> = {};
  if (existsSync(globalConfigPath)) raw = deepMerge(raw, loadJsonFile(globalConfigPath));
  if (existsSync(localConfigPath)) raw = deepMerge(raw, loadJsonFile(localConfigPath));
  raw = deepMerge(raw, fromEnv());
  if (overrides) raw = deepMerge(raw, overrides as Record<string, unknown>);

  const parsed = OrcConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid orc config:\n${parsed.error.message}`);
  }

  parsed.data.db.path = resolvePath(parsed.data.db.path);
  _config = parsed.data;
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
