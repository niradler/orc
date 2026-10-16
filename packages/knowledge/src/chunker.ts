import type { ParsedBlock } from "@orc/core/kb";

export type Chunk = {
  ordinal: number;
  heading_path: string[];
  locator: ParsedBlock["locator"] | null;
  text: string;
};

export const CHUNK_TARGET_CHARS = 1600;
export const CHUNK_MAX_CHARS = 2400;

/** chars/4 is close enough for budgeting English and code; it overestimates Hebrew slightly. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const blockText = (b: ParsedBlock) => {
  if (b.kind === "heading") return `${"#".repeat(b.level ?? 1)} ${b.text}`;
  if (b.kind === "list_item") return `- ${b.text}`;
  if (b.kind === "code") return `\`\`\`\n${b.text}\n\`\`\``;
  if (b.kind === "table" && b.rows?.length)
    return b.rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return b.text;
};

/** Splits an oversized block; tables repeat their header row so every piece stays readable. */
function splitBlock(b: ParsedBlock): ParsedBlock[] {
  const text = blockText(b);
  if (text.length <= CHUNK_MAX_CHARS) return [b];
  if (b.kind === "table" && b.rows && b.rows.length > 2) {
    const [head, ...body] = b.rows;
    if (!head) return [b];
    const pieces: ParsedBlock[] = [];
    let rows: string[][] = [];
    let size = 0;
    for (const row of body) {
      const len = row.join(" | ").length + 4;
      if (rows.length && size + len > CHUNK_TARGET_CHARS) {
        pieces.push({ ...b, rows: [head, ...rows], text: "" });
        rows = [];
        size = 0;
      }
      rows.push(row);
      size += len;
    }
    if (rows.length) pieces.push({ ...b, rows: [head, ...rows], text: "" });
    return pieces.map((p) => ({ ...p, text: (p.rows ?? []).map((r) => r.join(" | ")).join("\n") }));
  }
  const parts: string[] = [];
  const units = b.text.split(b.kind === "code" ? /(?<=\n)/ : /(?<=[.!?。])\s+|\n+/);
  let cur = "";
  for (const unit of units) {
    if (cur && cur.length + unit.length + 1 > CHUNK_TARGET_CHARS) {
      parts.push(cur);
      cur = "";
    }
    if (unit.length > CHUNK_MAX_CHARS) {
      for (let i = 0; i < unit.length; i += CHUNK_TARGET_CHARS)
        parts.push(unit.slice(i, i + CHUNK_TARGET_CHARS));
      continue;
    }
    cur = cur ? `${cur}${b.kind === "code" ? "" : " "}${unit}` : unit;
  }
  if (cur) parts.push(cur);
  return parts.map((text) => ({ ...b, text }));
}

/** Heading-aware packing: a new section starts a new chunk once the current one is substantial. */
export function chunkBlocks(blocks: ParsedBlock[]): Chunk[] {
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
  for (const block of blocks.flatMap(splitBlock)) {
    const text = blockText(block);
    const sectionBreak = block.kind === "heading" && (block.level ?? 1) <= 3 && size >= 400;
    const pageBreak =
      first?.locator?.page !== undefined &&
      block.locator?.page !== first.locator.page &&
      size >= CHUNK_TARGET_CHARS / 2;
    if (sectionBreak || pageBreak || (size && size + text.length > CHUNK_MAX_CHARS)) emit();
    first ??= block;
    parts.push(text);
    size += text.length + 2;
    if (size >= CHUNK_TARGET_CHARS && block.kind !== "heading") emit();
  }
  emit();
  return chunks;
}
