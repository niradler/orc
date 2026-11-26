import type { HumanResponse } from "@orc/core/human-requests";
import { ulid } from "@orc/core/ids";
import { getSqlite } from "@orc/db/client";
import { HumanRequestStore } from "@orc/db/human-requests";
import type { ElicitFn } from "./code-mode.js";

/**
 * HTTP/stateless elicitation path. ORC's MCP HTTP transport handles one request
 * per connection, so a server-initiated `elicitation/create` cannot round-trip.
 * Instead, the host asks its own user through a durable human request (webchat,
 * Telegram, push) and the tool call waits — the code-exec sandbox pauses its
 * clock while waiting. Live (stdio) connections keep using spec elicitation.
 */
const WAIT_MS = (() => {
  const parsed = Number(process.env.ORC_MCP_ELICIT_WAIT_MS);
  return Number.isFinite(parsed) && parsed >= 1000 ? Math.min(parsed, 300_000) : 120_000;
})();
const POLL_MS = 500;
const FAILED_STATUSES = new Set(["expired", "cancelled", "unavailable"]);
const ALL_CHANNELS = ["telegram", "slack", "slack-user"] as const;
type NotifyChannel = (typeof ALL_CHANNELS)[number];
const DEFAULT_CHANNELS: NotifyChannel[] = ["telegram", "slack"];

/**
 * Channels to notify for an elicitation request. Delivery is still gated by the
 * configured targets for the request's project, so listing a provider without a
 * connection is a no-op.
 */
function notifyChannels(): NotifyChannel[] {
  const configured = process.env.ORC_MCP_ELICIT_NOTIFY?.split(",")
    .map((value) => value.trim())
    .filter((value): value is NotifyChannel => (ALL_CHANNELS as readonly string[]).includes(value));
  return configured?.length ? configured.slice(0, 2) : [...DEFAULT_CHANNELS];
}

type PropertySchema = {
  type?: string;
  enum?: unknown[];
  oneOf?: { const?: unknown }[];
  description?: string;
};
type FormSchema = { properties?: Record<string, PropertySchema> };

export type HumanElicitTarget = {
  sessionId?: string | null | undefined;
  projectId?: string | null | undefined;
  signal?: AbortSignal | undefined;
  /** Test seam; production uses ORC_MCP_ELICIT_WAIT_MS. */
  waitMs?: number | undefined;
};

function enumValues(schema: PropertySchema | undefined): string[] | undefined {
  if (!schema) return undefined;
  if (Array.isArray(schema.enum)) return schema.enum.map(String);
  if (Array.isArray(schema.oneOf)) {
    const values = schema.oneOf.map((option) => option.const).filter((v) => v !== undefined);
    if (values.length) return values.map(String);
  }
  return undefined;
}

function coerce(value: string, schema: PropertySchema | undefined): unknown {
  const type = schema?.type;
  if (type === "integer" || type === "number") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return type === "integer" ? Math.trunc(numeric) : numeric;
  }
  if (type === "boolean") return /^(true|1|yes|y)$/i.test(value.trim());
  return value;
}

function describe(schema: FormSchema, message: string): string {
  const properties = schema.properties ?? {};
  const keys = Object.keys(properties);
  if (keys.length === 0) return message;
  if (keys.length === 1) {
    const key = keys[0] as string;
    const property = properties[key];
    const options = enumValues(property);
    const hint = options ? `one of: ${options.join(", ")}` : (property?.type ?? "text");
    const detail = property?.description ? ` — ${property.description}` : "";
    return `${message}\n\nReply with ${hint}${detail}.`;
  }
  const fields = keys
    .map(
      (key) =>
        `${key} (${enumValues(properties[key])?.join(" | ") ?? properties[key]?.type ?? "text"})`,
    )
    .join(", ");
  return `${message}\n\nReply with JSON containing: ${fields}.`;
}

function answerFrom(
  response: HumanResponse,
  single: string | undefined,
  singleSchema: PropertySchema | undefined,
  keys: string[],
): { action: "accept" | "decline"; content?: Record<string, unknown> | undefined } {
  if (response.kind !== "question") return { action: "decline" };
  if (single) {
    const value = response.selected_choices?.[0] ?? response.answer;
    return { action: "accept", content: { [single]: coerce(value, singleSchema) } };
  }
  try {
    const parsed = JSON.parse(response.answer) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { action: "accept", content: parsed as Record<string, unknown> };
    }
  } catch {
    // The prompt asks for JSON; a free-text answer for several fields is ambiguous.
  }
  if (keys.length === 0) return { action: "accept", content: {} };
  return { action: "decline" };
}

export function createHumanElicit(target: HumanElicitTarget): ElicitFn {
  const store = new HumanRequestStore(getSqlite());
  return async ({ message, requestedSchema }) => {
    const waitMs = Math.max(1, Math.min(target.waitMs ?? WAIT_MS, 300_000));
    const schema = (requestedSchema ?? {}) as FormSchema;
    const properties = schema.properties ?? {};
    const keys = Object.keys(properties);
    const single = keys.length === 1 ? (keys[0] as string) : undefined;
    const singleSchema = single ? properties[single] : undefined;
    const choices = single ? enumValues(singleSchema) : undefined;
    const created = store.create({
      origin: {
        session_id: target.sessionId ?? `mcp-elicitation:${process.pid}`,
        // The calling agent's backend lets ORC route the question back to its
        // chat session; without a real backend it still reaches Notifications.
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
      // The blocked tool call consumes this answer; delivering it again as a
      // session turn would duplicate the response.
      deliver_to_session: false,
      expires_in_seconds: Math.max(1, Math.ceil(waitMs / 1000)),
    });
    const deadline = Date.now() + waitMs;
    const abandon = () => {
      try {
        const latest = store.get(created.id);
        if (latest.status === "pending") store.cancel(latest.id, latest.version);
      } catch {
        // Already answered or expired; nothing to cancel.
      }
    };
    while (Date.now() < deadline) {
      if (target.signal?.aborted) {
        abandon();
        return { action: "cancel" };
      }
      await Bun.sleep(POLL_MS);
      const request = store.get(created.id);
      if (request.status === "answered" && request.response)
        return answerFrom(request.response, single, singleSchema, keys);
      if (FAILED_STATUSES.has(request.status)) return { action: "cancel" };
    }
    abandon();
    return { action: "cancel" };
  };
}
