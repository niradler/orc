const MIN_SECRET_LENGTH = 4;
const MAX_REGISTERED_SECRETS = 2000;

const registered = new Set<string>();

export function secretVariants(value: string): string[] {
  if (!value || value.length < MIN_SECRET_LENGTH) return [];
  const variants = new Set<string>([value]);
  try {
    const encoded = encodeURIComponent(value);
    if (encoded.length >= MIN_SECRET_LENGTH) variants.add(encoded);
  } catch {}
  try {
    const b64 = Buffer.from(value, "utf8").toString("base64");
    if (b64.length >= MIN_SECRET_LENGTH) variants.add(b64);
  } catch {}
  try {
    const jsonEscaped = JSON.stringify(value).slice(1, -1);
    if (jsonEscaped.length >= MIN_SECRET_LENGTH) variants.add(jsonEscaped);
  } catch {}
  return [...variants];
}

export function registerRedactedSecrets(values: Iterable<string>): void {
  for (const raw of values) {
    if (!raw || raw.length < MIN_SECRET_LENGTH) continue;
    if (registered.has(raw)) continue;
    if (registered.size >= MAX_REGISTERED_SECRETS) {
      const oldest = registered.values().next().value;
      if (oldest !== undefined) registered.delete(oldest);
    }
    registered.add(raw);
  }
}

export function getRegisteredSecrets(): string[] {
  const expanded = new Set<string>();
  for (const raw of registered) {
    for (const variant of secretVariants(raw)) expanded.add(variant);
  }
  return [...expanded].sort((a, b) => b.length - a.length);
}

export function redactRegisteredSecrets(text: string, extraValues: Iterable<string> = []): string {
  if (!text) return text;
  const secrets = new Set<string>(getRegisteredSecrets());
  for (const extra of extraValues) {
    for (const variant of secretVariants(extra)) secrets.add(variant);
  }
  if (!secrets.size) return text;
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  let out = text;
  for (const secret of ordered) {
    if (out.includes(secret)) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

export function resetRedactedSecrets(): void {
  registered.clear();
}
