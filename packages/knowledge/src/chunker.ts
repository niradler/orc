import type { ParsedBlock } from "@orc/core/kb";
import { chunkBlocks as legacyChunks } from "./chunker-v1.js";

export type Chunk = {
  ordinal: number;
  heading_path: string[];
  locator: ParsedBlock["locator"] | null;
  text: string;
};

export const CHUNK_TARGET_CHARS = 1600;
export const CHUNK_MAX_CHARS = 2400;

/** Display estimate only. Language, code and model tokenizers can differ substantially. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** Prefer sentence/line/word boundaries; never split a surrogate pair. */
export function splitPassageText(text: string, max = CHUNK_TARGET_CHARS): string[] {
  if (!Number.isInteger(max) || max < 2) throw new Error("Invalid passage size");
  const parts: string[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(text.length, at + max);
    if (end < text.length) {
      const section = text.slice(at, end);
      const sentences = [...section.matchAll(/(?:[.!?。][ \t]+|\n+)/g)];
      const sentence = sentences.at(-1);
      const last =
        sentence && sentence.index + sentence[0].length >= max / 2
          ? sentence
          : [...section.matchAll(/[ \t]+/g)].at(-1);
      if (last && last.index + last[0].length >= max / 2) end = at + last.index + last[0].length;
      const previous = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    }
    parts.push(text.slice(at, end));
    at = end;
  }
  return parts;
}

function render(block: ParsedBlock): string {
  if (block.kind === "heading") return `${"#".repeat(block.level ?? 1)} ${block.text}`;
  if (block.kind === "list_item") return `- ${block.text}`;
  if (block.kind === "code") return `\`\`\`\n${block.text}\n\`\`\``;
  if (block.kind === "table" && block.rows?.length)
    return block.rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
  return block.text;
}

function pieces(block: ParsedBlock): string[] {
  const text = render(block);
  if (text.length <= CHUNK_MAX_CHARS) return text ? [text] : [];
  if (block.kind === "code")
    return splitPassageText(block.text, CHUNK_TARGET_CHARS - 8).map(
      (part) => `\`\`\`\n${part}\n\`\`\``,
    );
  if (block.kind === "table" && block.rows?.length) {
    const rows = block.rows.map((row) => `| ${row.join(" | ")} |`);
    const header = rows[0] ?? "";
    // A huge header cannot be repeated safely. Retain all characters as plain fragments.
    if (header.length > CHUNK_TARGET_CHARS / 2) return splitPassageText(text);
    const result: string[] = [];
    let current = header;
    const budget = CHUNK_TARGET_CHARS - header.length - 1;
    for (const row of rows.slice(1)) {
      for (const part of splitPassageText(row, budget)) {
        if (current.length + part.length + 1 > CHUNK_TARGET_CHARS && current !== header) {
          result.push(current);
          current = header;
        }
        current += `\n${part}`;
      }
    }
    if (current) result.push(current);
    return result;
  }
  return splitPassageText(text);
}

/** Revision metadata owns the version: rebuilding an old index must not move citations. */
export function chunkBlocks(blocks: ParsedBlock[], version = 2): Chunk[] {
  if (version === 1) return legacyChunks(blocks);
  if (version !== 2) throw new Error("Unsupported passage chunking version");
  const chunks: Chunk[] = [];
  let parts: string[] = [];
  let size = 0;
  let first: ParsedBlock | undefined;
  const emit = () => {
    if (!first || !parts.length) return;
    chunks.push({
      ordinal: chunks.length,
      heading_path: first.heading_path,
      locator: first.locator ?? null,
      text: parts.join("\n\n"),
    });
    parts = [];
    size = 0;
    first = undefined;
  };
  for (const block of blocks) {
    for (const text of pieces(block)) {
      const differentSource =
        first &&
        (JSON.stringify(first.heading_path) !== JSON.stringify(block.heading_path) ||
          JSON.stringify(first.locator ?? null) !== JSON.stringify(block.locator ?? null));
      if (differentSource || (parts.length && size + 2 + text.length > CHUNK_MAX_CHARS)) emit();
      first ??= block;
      size += (parts.length ? 2 : 0) + text.length;
      parts.push(text);
      if (size >= CHUNK_TARGET_CHARS && block.kind !== "heading") emit();
    }
  }
  emit();
  return chunks;
}
