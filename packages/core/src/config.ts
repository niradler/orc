import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const ChannelDefaultModeSchema = z
  .enum(["direct", "agent:claude", "agent:codex", "agent:cursor", "multi"])
  .or(z.string().startsWith("job:"))
  .default("direct");

export const GatewayPlatformConfigSchema = z.object({
  enabled: z.boolean().default(false),
  token: z.string().optional(),
  bot_token: z.string().optional(),
  app_token: z.string().optional(),
  authorized_users: z.array(z.union([z.string(), z.number()])).default([]),
  default_chat_id: z.string().optional(),
  mode: ChannelDefaultModeSchema,
  allow_channel_mentions: z.boolean().default(true),
  share_session_in_channel: z.boolean().default(false),
  streaming_preview: z.boolean().default(true),
});

export const SpeechProviderConfigSchema = z.object({
  api_key: z.string().optional(),
  base_url: z.string().optional(),
  model: z.string().optional(),
});

export const SpeechConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(["openai", "groq", "qwen"]).default("openai"),
  language: z.string().default(""),
  openai: SpeechProviderConfigSchema.default({}),
  groq: SpeechProviderConfigSchema.default({}),
  qwen: SpeechProviderConfigSchema.default({}),
});

export const TtsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(["openai", "qwen"]).default("openai"),
  voice: z.string().default("alloy"),
  mode: z.enum(["voice_only", "always"]).default("voice_only"),
  max_text_len: z.number().int().min(0).default(0),
  openai: SpeechProviderConfigSchema.default({}),
  qwen: SpeechProviderConfigSchema.default({}),
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

  gateway: z
    .object({
      telegram: GatewayPlatformConfigSchema.default({}),
      slack: GatewayPlatformConfigSchema.default({}),
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

  speech: SpeechConfigSchema.default({}),
  tts: TtsConfigSchema.default({}),
});

export type OrcConfig = z.infer<typeof OrcConfigSchema>;
export type GatewayPlatformConfig = z.infer<typeof GatewayPlatformConfigSchema>;

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

  const api: Record<string, unknown> = {};
  if (process.env.ORC_API_PORT) api.port = Number(process.env.ORC_API_PORT);
  if (process.env.ORC_API_HOST) api.host = process.env.ORC_API_HOST;
  if (process.env.ORC_API_SECRET) api.secret = process.env.ORC_API_SECRET;
  if (Object.keys(api).length) env.api = api;

  const runner: Record<string, unknown> = {};
  if (process.env.ORC_RUNNER_TIMEOUT)
    runner.default_timeout_secs = Number(process.env.ORC_RUNNER_TIMEOUT);
  if (process.env.ORC_RUNNER_MAX_JOBS)
    runner.max_concurrent_jobs = Number(process.env.ORC_RUNNER_MAX_JOBS);
  if (process.env.ORC_RUNNER_LOG_DAYS)
    runner.log_retention_days = Number(process.env.ORC_RUNNER_LOG_DAYS);
  if (Object.keys(runner).length) env.runner = runner;

  const context: Record<string, unknown> = {};
  if (process.env.ORC_SNAPSHOT_MAX_BYTES)
    context.snapshot_max_bytes = Number(process.env.ORC_SNAPSHOT_MAX_BYTES);
  if (process.env.ORC_LAYER1_TASKS)
    context.layer1_task_limit = Number(process.env.ORC_LAYER1_TASKS);
  if (process.env.ORC_LAYER1_MEMORIES)
    context.layer1_memory_limit = Number(process.env.ORC_LAYER1_MEMORIES);
  if (Object.keys(context).length) env.context = context;

  const gateway: Record<string, unknown> = {};
  if (process.env.ORC_TELEGRAM_TOKEN) {
    gateway.telegram = { token: process.env.ORC_TELEGRAM_TOKEN, enabled: true };
  }
  if (process.env.ORC_SLACK_BOT_TOKEN || process.env.ORC_SLACK_APP_TOKEN) {
    gateway.slack = {
      bot_token: process.env.ORC_SLACK_BOT_TOKEN,
      app_token: process.env.ORC_SLACK_APP_TOKEN,
      enabled: true,
    };
  }
  if (Object.keys(gateway).length) env.gateway = gateway;

  const speech: Record<string, unknown> = {};
  if (process.env.ORC_SPEECH_PROVIDER) speech.provider = process.env.ORC_SPEECH_PROVIDER;
  if (process.env.ORC_SPEECH_LANGUAGE) speech.language = process.env.ORC_SPEECH_LANGUAGE;
  if (process.env.ORC_OPENAI_API_KEY) speech.openai = { api_key: process.env.ORC_OPENAI_API_KEY };
  if (process.env.ORC_GROQ_API_KEY) speech.groq = { api_key: process.env.ORC_GROQ_API_KEY };
  if (process.env.ORC_QWEN_API_KEY) speech.qwen = { api_key: process.env.ORC_QWEN_API_KEY };
  if (Object.keys(speech).length) {
    speech.enabled = true;
    env.speech = speech;
  }

  const tts: Record<string, unknown> = {};
  if (process.env.ORC_TTS_PROVIDER) tts.provider = process.env.ORC_TTS_PROVIDER;
  if (process.env.ORC_TTS_VOICE) tts.voice = process.env.ORC_TTS_VOICE;
  if (process.env.ORC_TTS_MODE) tts.mode = process.env.ORC_TTS_MODE;
  if (Object.keys(tts).length) {
    tts.enabled = true;
    env.tts = tts;
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

  // Backwards compatibility: bridge: key was renamed to gateway: in v0.1.0
  if (raw.bridge && !raw.gateway) {
    raw.gateway = raw.bridge;
  }
  delete raw.bridge;

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
