import type { OrcElicitationHandler } from "./mcp-client.js";

/** The subset of Pi's UI context needed to answer an elicitation. */
export type ElicitationUi = {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
};

type PropertySchema = {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
};

function coerce(value: string, type: string | undefined): string | number | boolean {
  if (type === "integer" || type === "number") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return type === "integer" ? Math.trunc(numeric) : numeric;
  }
  if (type === "boolean") return /^(true|1|yes|y)$/i.test(value.trim());
  return value;
}

/**
 * Answer a live MCP elicitation from Pi's terminal UI. Returned content matches
 * the SDK's scalar form values; the server validates it against its schema.
 */
export function uiElicitation(ui: ElicitationUi): OrcElicitationHandler {
  return async ({ message, requestedSchema }) => {
    const properties = ((requestedSchema as { properties?: Record<string, PropertySchema> })
      .properties ?? {}) as Record<string, PropertySchema>;
    const keys = Object.keys(properties);
    if (keys.length === 0) {
      if (!(await ui.confirm("ORC needs input", message))) return { action: "decline" };
      return { action: "accept", content: {} };
    }
    const content: Record<string, string | number | boolean | string[]> = {};
    for (const key of keys) {
      const property = properties[key] ?? {};
      const title = `${message} — ${property.title ?? key}`;
      const options = Array.isArray(property.enum) ? property.enum.map(String) : undefined;
      if (options?.length) {
        const picked = await ui.select(title, options);
        if (picked === undefined) return { action: "cancel" };
        content[key] = coerce(picked, property.type);
        continue;
      }
      const value = await ui.input(title, property.description ?? "");
      if (value === undefined) return { action: "cancel" };
      content[key] = coerce(value, property.type);
    }
    return { action: "accept", content };
  };
}
