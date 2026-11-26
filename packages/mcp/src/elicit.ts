import { changes } from "@orc/core/changes";
import type { HumanResponse } from "@orc/core/human-requests";
import { ulid } from "@orc/core/ids";
import { getSqlite } from "@orc/db/client";
import { HumanRequestStore } from "@orc/db/human-requests";
import type { ElicitFn } from "./code-mode.js";

const POLL_MS = 500;
const MAX_WAIT_MS = 300_000;
const DEFAULT_WAIT_MS = 120_000;
const MAX_HUMAN_CHOICES = 20;
const MAX_PROMPT_CHARS = 16_000;
const FAILED_STATUSES = new Set(["expired", "cancelled", "unavailable"]);
const ALL_CHANNELS = ["telegram", "slack", "slack-user"] as const;
type NotifyChannel = (typeof ALL_CHANNELS)[number];
const DEFAULT_CHANNELS: NotifyChannel[] = ["telegram", "slack"];
const SECRET_FIELD = /password|passphrase|secret|token|credential|api.?key|private[_ -]?key/i;

function defaultWaitMs(): number {
  const parsed = Number(process.env.ORC_MCP_ELICIT_WAIT_MS);
  return Number.isFinite(parsed) && parsed >= 1000
    ? Math.min(parsed, MAX_WAIT_MS)
    : DEFAULT_WAIT_MS;
}

function notifyChannels(): NotifyChannel[] {
  const configured = process.env.ORC_MCP_ELICIT_NOTIFY?.split(",")
    .map((value) => value.trim())
    .filter((value): value is NotifyChannel => (ALL_CHANNELS as readonly string[]).includes(value));
  return configured?.length ? configured.slice(0, 2) : [...DEFAULT_CHANNELS];
}

type OptionEntry = { const?: unknown; title?: unknown; description?: unknown };
type PropertySchema = {
  type?: string;
  title?: string;
  description?: string;
  format?: string;
  writeOnly?: boolean;
  enum?: unknown[];
  oneOf?: OptionEntry[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
};
type FormSchema = {
  properties?: Record<string, PropertySchema>;
  required?: unknown[];
};

export type HumanElicitTarget = {
  sessionId?: string | null | undefined;
  projectId?: string | null | undefined;
  signal?: AbortSignal | undefined;
  waitMs?: number | undefined;
};

export function assertNonSecretElicitSchema(requestedSchema: Record<string, unknown>): void {
  const properties = (requestedSchema as FormSchema).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return;
  for (const [key, raw] of Object.entries(properties)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const field = raw as PropertySchema;
    const optionText = [
      ...(Array.isArray(field.enum) ? field.enum.map(String) : []),
      ...(Array.isArray(field.oneOf)
        ? field.oneOf.flatMap((option) => [
            option.const !== undefined ? String(option.const) : "",
            typeof option.title === "string" ? option.title : "",
            typeof option.description === "string" ? option.description : "",
          ])
        : []),
    ].join(" ");
    const haystack = [
      key,
      typeof field.title === "string" ? field.title : "",
      typeof field.description === "string" ? field.description : "",
      optionText,
    ].join(" ");
    if (field.format === "password" || field.writeOnly === true || SECRET_FIELD.test(haystack)) {
      throw new Error(
        "Form elicitation cannot collect secrets; use human_request with kind 'secret' instead.",
      );
    }
  }
}

function allowedConstants(schema: PropertySchema | undefined): unknown[] | undefined {
  if (!schema) return undefined;
  if (Array.isArray(schema.enum)) return schema.enum;
  if (Array.isArray(schema.oneOf)) {
    const values = schema.oneOf.map((option) => option.const).filter((v) => v !== undefined);
    if (values.length) return values;
  }
  return undefined;
}

function enumValues(schema: PropertySchema | undefined): string[] | undefined {
  const values = allowedConstants(schema);
  return values?.length ? values.map(String) : undefined;
}

function parseScalar(
  raw: unknown,
  schema: PropertySchema | undefined,
): { ok: true; value: string | number | boolean } | { ok: false } {
  const type = schema?.type;
  let value: string | number | boolean;
  if (type === "integer" || type === "number") {
    const numeric =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && raw.trim() !== ""
          ? Number(raw)
          : Number.NaN;
    if (!Number.isFinite(numeric)) return { ok: false };
    if (type === "integer" && !Number.isInteger(numeric)) return { ok: false };
    if (typeof schema?.minimum === "number" && numeric < schema.minimum) return { ok: false };
    if (typeof schema?.maximum === "number" && numeric > schema.maximum) return { ok: false };
    value = numeric;
  } else if (type === "boolean") {
    if (typeof raw === "boolean") {
      value = raw;
    } else if (typeof raw === "string") {
      const normalized = raw.trim();
      if (/^(true|1|yes|y)$/i.test(normalized)) value = true;
      else if (/^(false|0|no|n)$/i.test(normalized)) value = false;
      else return { ok: false };
    } else {
      return { ok: false };
    }
  } else {
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
      return { ok: false };
    }
    const text = String(raw);
    if (typeof schema?.minLength === "number" && text.length < schema.minLength) {
      return { ok: false };
    }
    if (typeof schema?.maxLength === "number" && text.length > schema.maxLength) {
      return { ok: false };
    }
    value = text;
  }

  const allowed = allowedConstants(schema);
  if (allowed) {
    const matched = allowed.find((entry) => entry === value || String(entry) === String(value));
    if (
      matched === undefined ||
      (typeof matched !== "string" && typeof matched !== "number" && typeof matched !== "boolean")
    ) {
      return { ok: false };
    }
    value = matched;
  }
  return { ok: true, value };
}

function describe(schema: FormSchema, message: string): string {
  const properties = schema.properties ?? {};
  const keys = Object.keys(properties);
  if (keys.length === 0) return message.slice(0, MAX_PROMPT_CHARS);
  if (keys.length === 1) {
    const key = keys[0] as string;
    const property = properties[key];
    const options = enumValues(property);
    const hint = options ? `one of: ${options.join(", ")}` : (property?.type ?? "text");
    const detail = property?.description ? ` — ${property.description}` : "";
    return `${message}\n\nReply with ${hint}${detail}.`.slice(0, MAX_PROMPT_CHARS);
  }
  const fields = keys
    .map(
      (key) =>
        `${key} (${enumValues(properties[key])?.join(" | ") ?? properties[key]?.type ?? "text"})`,
    )
    .join(", ");
  return `${message}\n\nReply with JSON containing: ${fields}.`.slice(0, MAX_PROMPT_CHARS);
}

function answerFrom(
  response: HumanResponse,
  schema: FormSchema,
  single: string | undefined,
  keys: string[],
): { action: "accept" | "decline"; content?: Record<string, unknown> | undefined } {
  if (response.kind !== "question") return { action: "decline" };
  const properties = schema.properties ?? {};
  if (single) {
    const rawValue = response.selected_choices?.[0] ?? response.answer;
    const parsed = parseScalar(rawValue, properties[single]);
    if (!parsed.ok) return { action: "decline" };
    return { action: "accept", content: { [single]: parsed.value } };
  }
  if (keys.length === 0) return { action: "accept", content: {} };
  try {
    const parsed = JSON.parse(response.answer) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const required = Array.isArray(schema.required)
        ? schema.required.filter((entry): entry is string => typeof entry === "string")
        : [];
      const content: Record<string, unknown> = {};
      for (const key of keys) {
        if (!Object.hasOwn(record, key) || record[key] === undefined) {
          if (required.includes(key)) return { action: "decline" };
          continue;
        }
        const coerced = parseScalar(record[key], properties[key]);
        if (!coerced.ok) return { action: "decline" };
        content[key] = coerced.value;
      }
      return { action: "accept", content };
    }
  } catch {}
  return { action: "decline" };
}

function sleepUntil(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function combineSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  if (a && b) return AbortSignal.any([a, b]);
  return a ?? b;
}

export function createHumanElicit(target: HumanElicitTarget): ElicitFn {
  const store = new HumanRequestStore(getSqlite());
  return async ({ message, requestedSchema, signal: callSignal }) => {
    assertNonSecretElicitSchema(requestedSchema);
    const signal = combineSignals(target.signal, callSignal);
    if (signal?.aborted) return { action: "cancel" };
    const waitMs = Math.max(1, Math.min(target.waitMs ?? defaultWaitMs(), MAX_WAIT_MS));
    const schema = (requestedSchema ?? {}) as FormSchema;
    const properties = schema.properties ?? {};
    const keys = Object.keys(properties);
    const single = keys.length === 1 ? (keys[0] as string) : undefined;
    const singleSchema = single ? properties[single] : undefined;
    const rawChoices = single ? enumValues(singleSchema) : undefined;
    const choices = rawChoices && rawChoices.length <= MAX_HUMAN_CHOICES ? rawChoices : undefined;
    const created = store.create({
      origin: {
        session_id: target.sessionId ?? `mcp-elicitation:${process.pid}`,
        backend: process.env.ORC_AGENT || "mcp",
        request_id: `elicit-${ulid()}`,
      },
      project_id: target.projectId ?? null,
      kind: "question",
      title: "Input needed",
      prompt: describe(schema, message),
      choices: choices ?? [],
      multi_select: false,
      notify: notifyChannels(),
      deliver_to_session: false,
      expires_in_seconds: Math.max(1, Math.ceil(waitMs / 1000)),
    });
    changes.publish("human-requests", "notifications");
    const deadline = Date.now() + waitMs;
    const abandon = () => {
      try {
        const latest = store.get(created.id);
        if (latest.status === "pending") {
          store.cancel(latest.id, latest.version);
          changes.publish("human-requests", "notifications");
        }
      } catch {}
    };
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        abandon();
        return { action: "cancel" };
      }
      await sleepUntil(Math.min(POLL_MS, Math.max(1, deadline - Date.now())), signal);
      if (signal?.aborted) {
        abandon();
        return { action: "cancel" };
      }
      const request = store.get(created.id);
      if (request.status === "answered" && request.response) {
        try {
          store.acknowledge(request.id, request.version);
          changes.publish("human-requests", "notifications");
        } catch {}
        return answerFrom(request.response, schema, single, keys);
      }
      if (FAILED_STATUSES.has(request.status)) return { action: "cancel" };
    }
    abandon();
    return { action: "cancel" };
  };
}
