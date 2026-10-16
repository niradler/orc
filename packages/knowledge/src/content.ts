import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ParsedBlock } from "@orc/core/kb";
import type { DocRow, SourceRow } from "./catalog.js";
import type { Engine } from "./engine.js";
import { markdownToBlocks } from "./markdown.js";

export const isMarkdownName = (name: string) => /\.(md|markdown)$/i.test(name);

export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

export function sourceOf(engine: Engine, id: string | null): SourceRow | null {
  if (!id) return null;
  return engine.db.query("SELECT * FROM kb_sources WHERE id = ?").get(id) as SourceRow | null;
}

/**
 * Absolute path of an external document, refusing symlinks and anything that resolves outside
 * the registered folder (the folder may have changed since it was scanned).
 */
export function externalFile(source: SourceRow, rel: string): string {
  const parts = rel.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) throw new Error("Invalid external path");
  const root = realpathSync(source.root_path);
  let target = root;
  for (const part of parts) {
    target = join(target, part);
    if (lstatSync(target).isSymbolicLink()) throw new Error("Symlinked files are not followed");
  }
  const resolved = realpathSync(target);
  const inside = relative(root, resolved);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new Error("File must stay inside its registered folder");
  return resolved;
}

export type DocumentText = { markdown: string; blocks: ParsedBlock[] };

/** Markdown + blocks for any document: owned text (authored or a folder copy) or the parser artifact. */
export function documentText(engine: Engine, doc: DocRow): DocumentText | null {
  if (doc.media_type === "text/markdown" && doc.origin !== "upload") {
    const markdown = doc.content ?? "";
    return { markdown, blocks: markdownToBlocks(markdown) };
  }
  if (!doc.parser_id || !doc.parser_version) return null;
  const artifact = engine.storage.readArtifact(
    doc.id,
    doc.content_hash,
    doc.parser_id,
    doc.parser_version,
  );
  return artifact ? { markdown: artifact.markdown, blocks: artifact.blocks } : null;
}
