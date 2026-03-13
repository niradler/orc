const SENSITIVE_KEYS = new Set([
  "token",
  "bot_token",
  "app_token",
  "api_key",
  "secret",
  "password",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "ORC_API_SECRET",
  "ORC_TELEGRAM_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
]);

const TOKEN_PREFIXES = /\b(sk-[A-Za-z0-9\-_]{20,}|xox[bpoa]-[A-Za-z0-9\-]+|ghp_[A-Za-z0-9]{36}|AIza[A-Za-z0-9\-_]{35}|[0-9]{8,10}:[A-Za-z0-9\-_]{35})\b/g;

export function redactSecrets(text: string): string {
  return text.replace(TOKEN_PREFIXES, (match) => `${"*".repeat(match.length - 4)}${match.slice(-4)}`);
}

export function redactObject(obj: unknown, depth = 0): unknown {
  if (depth > 6 || obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((v) => redactObject(v, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key) && typeof value === "string" && value.length > 8) {
      result[key] = `${"*".repeat(value.length - 4)}${value.slice(-4)}`;
    } else {
      result[key] = redactObject(value, depth + 1);
    }
  }
  return result;
}
