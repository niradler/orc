import type { OrcElicitationHandler } from "./mcp-client.js";

export type ElicitationUi = {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
};

type OptionEntry = {
  const?: unknown;
  title?: unknown;
  description?: unknown;
  format?: unknown;
  writeOnly?: unknown;
};
type PropertySchema = {
  type?: string;
  title?: string;
  description?: string;
  format?: string;
  writeOnly?: boolean;
  enum?: unknown[];
  oneOf?: OptionEntry[];
  anyOf?: OptionEntry[];
  items?: PropertySchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
};

const SECRET_FIELD = /password|passphrase|secret|token|credential|api.?key|private[_ -]?key/i;

function objectEntries(entries: OptionEntry[] | undefined): OptionEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (option): option is OptionEntry =>
      Boolean(option) && typeof option === "object" && !Array.isArray(option),
  );
}

function optionTexts(entries: OptionEntry[] | undefined): string[] {
  return objectEntries(entries).flatMap((option) => [
    option.const !== undefined ? String(option.const) : "",
    typeof option.title === "string" ? option.title : "",
    typeof option.description === "string" ? option.description : "",
  ]);
}

function optionsHaveSecretAttr(entries: OptionEntry[] | undefined): boolean {
  return objectEntries(entries).some(
    (option) => option.format === "password" || option.writeOnly === true,
  );
}

function isSecretField(key: string, property: PropertySchema): boolean {
  if (property.format === "password" || property.writeOnly === true) return true;
  if (optionsHaveSecretAttr(property.oneOf) || optionsHaveSecretAttr(property.anyOf)) return true;
  const optionText = [
    ...(Array.isArray(property.enum) ? property.enum.map(String) : []),
    ...optionTexts(property.oneOf),
    ...optionTexts(property.anyOf),
  ].join(" ");
  if (
    SECRET_FIELD.test([key, property.title ?? "", property.description ?? "", optionText].join(" "))
  ) {
    return true;
  }
  if (property.items && typeof property.items === "object" && !Array.isArray(property.items)) {
    return isSecretField(key, property.items);
  }
  return false;
}

type ChoiceOption = { label: string; value: string | number | boolean };

function choicesFor(property: PropertySchema): ChoiceOption[] | undefined {
  if (Array.isArray(property.enum)) {
    const out: ChoiceOption[] = [];
    for (const raw of property.enum) {
      if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
        out.push({ label: String(raw), value: raw });
      }
    }
    return out.length ? out : undefined;
  }
  for (const union of [property.oneOf, property.anyOf]) {
    const entries = objectEntries(union);
    if (!entries.length) continue;
    const out: ChoiceOption[] = [];
    for (const option of entries) {
      const val = option.const;
      if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
        const label = typeof option.title === "string" && option.title ? option.title : String(val);
        out.push({ label, value: val });
      }
    }
    if (out.length) return out;
  }
  return undefined;
}

function coerce(
  value: string,
  property: PropertySchema,
): { ok: true; value: string | number | boolean } | { ok: false } {
  const type = property.type;
  if (type === "integer" || type === "number") {
    const numeric = value.trim() === "" ? Number.NaN : Number(value);
    if (!Number.isFinite(numeric)) return { ok: false };
    if (type === "integer" && !Number.isInteger(numeric)) return { ok: false };
    if (typeof property.minimum === "number" && numeric < property.minimum) return { ok: false };
    if (typeof property.maximum === "number" && numeric > property.maximum) return { ok: false };
    return { ok: true, value: numeric };
  }
  if (type === "boolean") {
    const normalized = value.trim();
    if (/^(true|1|yes|y)$/i.test(normalized)) return { ok: true, value: true };
    if (/^(false|0|no|n)$/i.test(normalized)) return { ok: true, value: false };
    return { ok: false };
  }
  if (typeof property.minLength === "number" && value.length < property.minLength) {
    return { ok: false };
  }
  if (typeof property.maxLength === "number" && value.length > property.maxLength) {
    return { ok: false };
  }
  return { ok: true, value };
}

export function uiElicitation(ui: ElicitationUi): OrcElicitationHandler {
  return async ({ message, requestedSchema }) => {
    const schema = requestedSchema as {
      properties?: Record<string, PropertySchema>;
      required?: unknown[];
    };
    const properties = (schema.properties ?? {}) as Record<string, PropertySchema>;
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((entry): entry is string => typeof entry === "string")
        : [],
    );
    const keys = Object.keys(properties);
    for (const key of keys) {
      if (isSecretField(key, properties[key] ?? {})) return { action: "decline" };
    }
    if (keys.length === 0) {
      if (!(await ui.confirm("ORC needs input", message))) return { action: "decline" };
      return { action: "accept", content: {} };
    }
    const content: Record<string, string | number | boolean | string[]> = {};
    for (const key of keys) {
      const property = properties[key] ?? {};
      const title = `${message} — ${property.title ?? key}`;
      const options = choicesFor(property);
      if (options?.length) {
        const picked = await ui.select(
          title,
          options.map((entry) => entry.label),
        );
        if (picked === undefined) return { action: "cancel" };
        const matched = options.find((entry) => entry.label === picked);
        if (!matched) return { action: "decline" };
        content[key] = matched.value;
        continue;
      }
      const value = await ui.input(title, property.description ?? "");
      if (value === undefined) return { action: "cancel" };
      if (value === "" && !required.has(key)) continue;
      const parsed = coerce(value, property);
      if (!parsed.ok) return { action: "decline" };
      content[key] = parsed.value;
    }
    return { action: "accept", content };
  };
}
