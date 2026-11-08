import type { JobEnvironment } from "./job-settings.js";
import { decryptSecret, encryptSecret } from "./secrets.js";

export function storeJobEnvironment(
  input: JobEnvironment,
  previous: JobEnvironment = [],
): JobEnvironment {
  return input.map((entry) => {
    if (entry.value === null) {
      const saved = previous.find((item) => item.name === entry.name && item.secret);
      if (!saved || !entry.secret) throw new Error("A saved secret is required to keep its value");
      return saved;
    }
    return { ...entry, value: entry.secret ? encryptSecret(entry.value) : entry.value };
  });
}

export function publicJobEnvironment(stored: JobEnvironment | null): JobEnvironment {
  return (stored ?? []).map((entry) => ({ ...entry, value: entry.secret ? null : entry.value }));
}

export function resolveJobEnvironment(stored: JobEnvironment | null): {
  env: Record<string, string>;
  redact: (text: string) => string;
} {
  const env = Object.fromEntries(
    (stored ?? []).map((entry) => [
      entry.name,
      entry.secret ? decryptSecret(entry.value ?? "") : (entry.value ?? ""),
    ]),
  );
  const secrets = (stored ?? [])
    .filter((entry) => entry.secret)
    .map((entry) => env[entry.name] ?? "")
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  return {
    env,
    redact: (text) =>
      secrets.reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), text),
  };
}
