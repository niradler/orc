import { isMap, isSeq, parseDocument } from "yaml";
import type { SkillFileInput } from "@/api/client";

export type PackageFormat = "apm" | "agent-plugin";
export type PackageInput = {
  name: string;
  content: string;
  files: SkillFileInput[];
  format: PackageFormat;
  skills: string[];
};
export const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

export function packageTemplate(format: PackageFormat): string {
  return format === "apm"
    ? "name: my-agent-package\nversion: '1.0.0'\ndescription: Describe when to use this configuration\ndependencies: {}\n"
    : JSON.stringify(
        {
          $schema: PLUGIN_SCHEMA,
          name: "my-agent-package",
          version: "1.0.0",
          description: "Describe when to use this configuration",
        },
        null,
        2,
      );
}

export function packageFields(source: string, format: PackageFormat): Record<string, unknown> {
  const document = format === "apm" ? parseDocument(source) : null;
  if (document?.errors.length) throw new Error(document.errors[0]?.message);
  const fields = document ? document.toJS() : JSON.parse(source);
  if (!fields || typeof fields !== "object" || Array.isArray(fields))
    throw new Error("Manifest must be an object");
  return fields;
}

export function setPackageField(
  source: string,
  format: PackageFormat,
  key: string,
  value: unknown,
): string {
  if (format === "agent-plugin")
    return JSON.stringify({ ...packageFields(source, format), [key]: value }, null, 2);
  const document = parseDocument(source);
  if (document.errors.length) throw new Error("Fix the manifest before switching to fields");
  document.set(key, value);
  return document.toString();
}

export function replacePackageFile(
  files: SkillFileInput[],
  path: string,
  content: string,
): SkillFileInput[] {
  const found = files.some((file) => file.path === path);
  return found
    ? files.map((file) => (file.path === path ? { ...file, content, encoding: "utf8" } : file))
    : [...files, { path, content, encoding: "utf8" }];
}

export function setInstructionBody(original: string | undefined, body: string): string {
  const header = original?.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/)?.[0];
  return `${header ?? "---\ndescription: Shared package instructions\n---\n"}${body}`;
}

export function setPackageMcp(source: string, declarations: string): string {
  const entries = parseDocument(declarations);
  if (entries.errors.length) throw new Error("Fix the MCP YAML before saving");
  const value = entries.toJS();
  if (!Array.isArray(value))
    throw new Error("MCP declarations must be a YAML list (use [] for none)");
  const document = parseDocument(source);
  if (document.errors.length) throw new Error("Fix apm.yml before editing MCP declarations");
  document.setIn(["dependencies", "mcp"], value);
  const dependencies = document.get("dependencies", true);
  if (isMap(dependencies)) dependencies.flow = false;
  const servers = document.getIn(["dependencies", "mcp"], true);
  if (isSeq(servers)) {
    servers.flow = false;
    for (const server of servers.items) if (isMap(server)) server.flow = false;
  }
  return document.toString();
}

export function validatePackageDraft(
  source: string,
  format: PackageFormat,
): Record<string, unknown> {
  const fields = packageFields(source, format);
  if (
    typeof fields.name !== "string" ||
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(fields.name) ||
    fields.name.length > 64
  )
    throw new Error(
      "Use a lowercase package name with single hyphens or periods (up to 64 characters)",
    );
  if (format === "apm" && (!fields.version || typeof fields.version !== "string"))
    throw new Error("APM packages require a version");
  if (format === "agent-plugin" && fields.$schema !== PLUGIN_SCHEMA)
    throw new Error("Use the Agent Plugins v1 schema");
  return fields;
}
