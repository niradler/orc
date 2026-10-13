import Ajv from "ajv/dist/2020.js";
import { ValidationError } from "./errors.js";
import mcpSchema from "./schemas/agent-plugins/mcp.schema.json";
import pluginSchema from "./schemas/agent-plugins/plugin.schema.json";
import type { SkillFileInput } from "./skill-files.js";

export type PluginManifest = Record<string, unknown> & {
  name: string;
  version?: string;
  description?: string;
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(pluginSchema);
const validateMcp = ajv.compile(mcpSchema);
const fields = new Set(Object.keys(pluginSchema.properties));

export function validatePluginMcp(files: SkillFileInput[]): void {
  const file = files.find((file) => file.path === "mcp.json");
  if (!file) return;
  let document: unknown;
  try {
    document = JSON.parse(Buffer.from(file.content, file.encoding ?? "utf8").toString("utf8"));
  } catch {
    throw new ValidationError("mcp.json must contain valid JSON");
  }
  if (!validateMcp(document))
    throw new ValidationError(
      `Invalid Agent Plugins MCP configuration: ${ajv.errorsText(validateMcp.errors)}`,
    );
}

export function parsePluginManifest(content: string): {
  manifest: PluginManifest;
  warnings: string[];
} {
  let input: unknown;
  try {
    input = JSON.parse(content);
  } catch {
    throw new ValidationError("plugin.json must contain valid JSON");
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ValidationError("plugin.json must be an object");
  const original = input as Record<string, unknown>;
  const warnings = Object.keys(original)
    .filter((key) => !fields.has(key))
    .map((key) => `Ignored unknown manifest field: ${key}`);
  const portable = Object.fromEntries(Object.entries(original).filter(([key]) => fields.has(key)));
  if (portable.extensions !== undefined) {
    if (
      !portable.extensions ||
      typeof portable.extensions !== "object" ||
      Array.isArray(portable.extensions)
    )
      warnings.push("Ignored non-object extensions field");
    // ORC implements no client extension namespace. The spec requires ignoring
    // their values without validation, even when they are not objects.
    delete portable.extensions;
  }
  if (!validate(portable))
    throw new ValidationError(`Invalid Agent Plugins manifest: ${ajv.errorsText(validate.errors)}`);
  return { manifest: original as PluginManifest, warnings };
}
