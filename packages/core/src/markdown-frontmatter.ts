import { ValidationError } from "./errors.js";

export function parseMarkdownFrontmatter(content: string): {
  fields: Record<string, unknown>;
  body: string;
} {
  const match = content
    .replace(/^\uFEFF/, "")
    .match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!match) throw new ValidationError("Missing YAML frontmatter enclosed by ---");
  let fields: unknown;
  try {
    fields = Bun.YAML.parse(match[1] as string);
  } catch (error) {
    throw new ValidationError(`Invalid YAML frontmatter: ${(error as Error).message}`);
  }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new ValidationError("YAML frontmatter must be a mapping");
  }
  return { fields: fields as Record<string, unknown>, body: (match[2] ?? "").trim() };
}
