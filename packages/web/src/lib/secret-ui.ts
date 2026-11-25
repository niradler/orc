import type { SecretField } from "@orc/core/human-requests";
import { defaultProjectSecretName } from "@orc/core/project-secrets";

export function secretAutocompleteHint(
  field: Pick<SecretField, "key" | "label" | "multiline">,
): string {
  if (field.multiline) return "off";
  const text = `${field.key} ${field.label}`.toLowerCase();
  if (/otp|totp|2fa|one[_ -]?time|verification[_ -]?code/.test(text)) return "one-time-code";
  if (/email/.test(text)) return "email";
  if (/user(name)?|login|account/.test(text)) return "username";
  if (/url|endpoint|host|domain/.test(text)) return "url";
  if (/pass(word|phrase)?|secret|token|api[_ -]?key|credential|key/.test(text))
    return "current-password";
  return "off";
}

export function initialSecretReferenceNames(
  fields: readonly SecretField[],
): Record<string, string> {
  const names: Record<string, string> = {};
  const used = new Set<string>();
  for (const field of fields) {
    const base = field.reference_name ?? defaultProjectSecretName(field.key);
    let candidate = base;
    let index = 2;
    while (used.has(candidate)) {
      candidate = `${base.slice(0, 60)}-${index++}`;
    }
    used.add(candidate);
    names[field.key] = candidate;
  }
  return names;
}

export function formatSecretLastUsed(iso: string | null): string {
  if (!iso) return "Never used";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Never used";
  return `Last used ${date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}
