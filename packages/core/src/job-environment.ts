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
  createRedactor: () => JobOutputRedactor;
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
  const redact = (text: string): string => redactSecrets(text, secrets);
  return { env, redact, createRedactor: () => createJobOutputRedactor(secrets) };
}

export type JobOutputRedactor = { write: (text: string) => string; finish: () => string };

export function createJobOutputRedactor(values: string[]): JobOutputRedactor {
  const secrets = [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length);
  const carry = Math.max(0, ...secrets.map((secret) => secret.length - 1));
  let pending = "";
  let covered = 0;
  let continuing = false;
  const emit = (final: boolean): string => {
    let boundary = final ? pending.length : Math.max(0, pending.length - carry);
    const last = pending.charCodeAt(boundary - 1);
    if (!final && last >= 0xd800 && last <= 0xdbff) boundary--;
    const ranges = secretRanges(pending, secrets, covered);
    let cursor = 0;
    let nextCovered = 0;
    const output: string[] = [];
    for (const [start, end] of ranges) {
      if (end > boundary && start <= boundary) nextCovered = end - boundary;
      if (start >= boundary) continue;
      if (start > cursor) {
        output.push(pending.slice(cursor, start));
        continuing = false;
      }
      if (!continuing) output.push("[REDACTED]");
      cursor = Math.min(end, boundary);
      continuing = end >= boundary;
    }
    if (cursor < boundary) {
      output.push(pending.slice(cursor, boundary));
      continuing = false;
    }
    // Only the unresolved raw suffix survives; coverage carries overlapping matches forward.
    pending = pending.slice(boundary);
    covered = nextCovered;
    return output.join("");
  };
  return {
    write(text) {
      pending += text;
      return emit(false);
    },
    finish() {
      const output = emit(true);
      continuing = false;
      return output;
    },
  };
}

function secretRanges(text: string, secrets: string[], covered = 0): [number, number][] {
  const positions = secrets.map((secret) => text.indexOf(secret));
  const ranges: [number, number][] = covered ? [[0, covered]] : [];
  while (true) {
    let next = -1;
    let start = text.length;
    for (let i = 0; i < positions.length; i++) {
      const position = positions[i] ?? -1;
      if (position >= 0 && position < start) {
        next = i;
        start = position;
      }
    }
    if (next < 0) break;
    const secret = secrets[next] ?? "";
    const end = start + secret.length;
    const previous = ranges.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else ranges.push([start, end]);
    positions[next] = text.indexOf(secret, start + 1);
  }
  return ranges;
}

function redactSecrets(text: string, secrets: string[]): string {
  let cursor = 0;
  const output: string[] = [];
  for (const [start, end] of secretRanges(text, secrets)) {
    output.push(text.slice(cursor, start), "[REDACTED]");
    cursor = end;
  }
  output.push(text.slice(cursor));
  return output.join("");
}
