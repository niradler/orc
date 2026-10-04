import { isMap, parseDocument } from "yaml";

export const AGENT_TEMPLATES = {
  specialist:
    "---\nname: Specialist\ndescription: Describe when to use this specialist\n---\n\nYou are a specialist. Define your role, scope, and expected output.\n",
  reviewer:
    "---\nname: Reviewer\ndescription: Review changes and report actionable findings\ntools:\n  Read: true\n  Grep: true\n  Bash: false\n---\n\nReview the working diff. Check correctness, security, and tests. Cite file paths and explain each finding.\n",
  builder:
    "---\nname: Builder\ndescription: Implement changes and verify the result\ntools:\n  Read: true\n  Edit: true\n  Write: true\n  Bash: true\n---\n\nImplement the requested change, preserve unrelated work, and run relevant checks. Report the result and any remaining issues.\n",
} as const;

export type ToolRow = { name: string; allowed: boolean };

export function readYamlMapping(source: string): {
  document: ReturnType<typeof parseDocument>;
  fields: Record<string, unknown>;
} {
  const document = parseDocument(source, { stringKeys: true });
  if (document.errors.length) throw new Error(document.errors[0].message);
  if (document.warnings.length) throw new Error(document.warnings[0].message);
  if (!isMap(document.contents)) throw new Error("YAML configuration must be a mapping.");
  const fields: unknown = document.toJS({ maxAliasCount: 100 });
  if (!fields || typeof fields !== "object" || Array.isArray(fields))
    throw new Error("YAML configuration must be a mapping.");
  JSON.stringify(fields);
  return { document, fields: fields as Record<string, unknown> };
}

export function readAgentDefinition(source: string): {
  document: ReturnType<typeof parseDocument>;
  fields: Record<string, unknown>;
  body: string;
  newline: string;
  bom: string;
} {
  const match = source
    .replace(/^\uFEFF/, "")
    .match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!match)
    throw new Error("Add YAML configuration between --- lines, followed by instructions.");
  return {
    ...readYamlMapping(match[1]),
    body: match[2] ?? "",
    newline: source.includes("\r\n") ? "\r\n" : "\n",
    bom: source.startsWith("\uFEFF") ? "\uFEFF" : "",
  };
}

export function setAgentField(source: string, name: string, value: unknown): string {
  const parsed = readAgentDefinition(source);
  if (value === undefined) parsed.document.delete(name);
  else parsed.document.set(name, value);
  const yaml = parsed.document.toString().trimEnd().replace(/\n/g, parsed.newline);
  return `${parsed.bom}---${parsed.newline}${yaml}${parsed.newline}---${parsed.newline}${parsed.body}`;
}

export function setAgentBody(source: string, body: string): string {
  const header = source.match(/^((?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---)(?:\r?\n[\s\S]*)?$/)?.[1];
  if (!header) throw new Error("Missing YAML configuration.");
  return `${header}${source.includes("\r\n") ? "\r\n" : "\n"}${body}`;
}

export function agentTools(fields: Record<string, unknown>): ToolRow[] {
  const tools = fields.tools;
  if (tools === undefined) return [];
  if (typeof tools === "string")
    return tools
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((name) => ({ name, allowed: true }));
  if (Array.isArray(tools) && tools.every((name) => typeof name === "string"))
    return tools.map((name) => ({ name, allowed: true }));
  if (tools && typeof tools === "object" && !Array.isArray(tools)) {
    return Object.entries(tools).map(([name, allowed]) => {
      if (typeof allowed !== "boolean") throw new Error(`Tool "${name}" must be true or false.`);
      return { name, allowed };
    });
  }
  throw new Error("Tools must be a mapping of names to true/false, a list, or a string.");
}

export function setAgentTools(source: string, tools: ToolRow[]): string {
  const parsed = readAgentDefinition(source);
  if (!isMap(parsed.document.get("tools", true))) parsed.document.set("tools", {});
  const existing = parsed.document.get("tools", true);
  if (isMap(existing)) {
    for (const { name: key } of agentTools(parsed.fields)) {
      if (!tools.some((tool) => tool.name === key)) parsed.document.deleteIn(["tools", key]);
    }
  }
  for (const tool of tools) parsed.document.setIn(["tools", tool.name], tool.allowed);
  return `${parsed.bom}---${parsed.newline}${parsed.document.toString().trimEnd().replace(/\n/g, parsed.newline)}${parsed.newline}---${parsed.newline}${parsed.body}`;
}
