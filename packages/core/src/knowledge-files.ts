import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { ConflictError, ValidationError } from "./errors.js";
import type { KnowledgeCollection, KnowledgeDocument } from "./knowledge.js";
import { validateCollectionPath } from "./validate.js";

export const MAX_KNOWLEDGE_EDIT_BYTES = 2 * 1024 * 1024;

export function resolveKnowledgeFile(
  document: KnowledgeDocument,
  collection: KnowledgeCollection,
): string {
  const prefix = `${collection.name}/`;
  if (document.collection !== collection.name || !document.path.startsWith(prefix))
    throw new ValidationError("Document does not belong to this collection");
  const filename = document.path.slice(prefix.length);
  if (!/\.(md|markdown)$/i.test(filename) || filename.includes("\\") || filename.includes(":"))
    throw new ValidationError("Only Markdown files inside a registered collection can be edited");
  const parts = filename.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new ValidationError("Invalid document path");
  const root = validateCollectionPath(realpathSync(collection.path));
  let target = root;
  for (const part of parts) {
    target = join(target, part);
    if (lstatSync(target).isSymbolicLink())
      throw new ValidationError("Document symlinks cannot be edited");
  }
  const resolved = realpathSync(target);
  const inside = relative(root, resolved);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new ValidationError("Document must stay inside its collection");
  const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.size > MAX_KNOWLEDGE_EDIT_BYTES)
    throw new ValidationError("Document must be a Markdown file no larger than 2 MiB");
  return resolved;
}

export function readKnowledgeFile(path: string): string {
  const bytes = readFileSync(path);
  try {
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (content.includes("\0")) throw new Error("binary");
    return content;
  } catch {
    throw new ValidationError("Document must contain UTF-8 text");
  }
}

export function editKnowledgeFile(
  document: KnowledgeDocument,
  collection: KnowledgeCollection,
  content: string,
  expectedContent: string,
): string {
  if (Buffer.byteLength(content, "utf8") > MAX_KNOWLEDGE_EDIT_BYTES || content.includes("\0"))
    throw new ValidationError("Document must contain UTF-8 text no larger than 2 MiB");
  const path = resolveKnowledgeFile(document, collection);
  if (readKnowledgeFile(path) !== expectedContent)
    throw new ConflictError(
      "This file changed since it was opened. Reopen it before saving; your draft has not been written.",
    );
  writeFileSync(path, content, "utf8");
  return content;
}
