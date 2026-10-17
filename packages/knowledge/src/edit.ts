import { ValidationError } from "@orc/core/errors";
import type { KbDocumentEdit } from "@orc/core/kb";

type Edit = KbDocumentEdit["edits"][number];
type Splice = { from: number; to: number; text: string; edit: number };
export type LineRange = { start_line: number; end_line: number };

/** Offset where each line starts. A trailing newline does not open another line. */
export function lineStarts(text: string): number[] {
  if (!text) return [];
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1 && i < text.length - 1; i = text.indexOf("\n", i + 1))
    starts.push(i + 1);
  return starts;
}

/** 1-based line containing `offset`. */
function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function occurrences(text: string, needle: string): number[] {
  const at: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length))
    at.push(i);
  return at;
}

function splicesOf(text: string, starts: number[], edit: Edit, index: number): Splice[] {
  const n = index + 1;
  if ("old" in edit) {
    const at = occurrences(text, edit.old);
    if (!at.length) throw new ValidationError(`Edit ${n}: the text to replace was not found`);
    if (at.length > 1 && !edit.replace_all)
      throw new ValidationError(
        `Edit ${n}: the text to replace matches ${at.length} times; add surrounding text to make it unique or set replace_all`,
      );
    return at.map((from) => ({ from, to: from + edit.old.length, text: edit.new, edit: index }));
  }
  const lines = starts.length;
  const { start_line: start, end_line: end } = edit;
  if (end < start - 1 || start > lines + 1 || end > lines)
    throw new ValidationError(
      `Edit ${n}: lines ${start}-${end} are outside the document (it has ${lines} lines); use end_line = start_line - 1 to insert`,
    );
  const from = start > lines ? text.length : (starts[start - 1] ?? 0);
  const to = end === 0 ? from : end < lines ? (starts[end] ?? text.length) : text.length;
  let insert = edit.new;
  // Whole lines are replaced, so the new text keeps the line break the old lines ended with.
  if (insert && !insert.endsWith("\n") && to > from && text[to - 1] === "\n") insert += "\n";
  if (
    insert &&
    to === from &&
    !insert.endsWith("\n") &&
    (from < text.length || text.endsWith("\n"))
  )
    insert += "\n";
  if (insert && from === text.length && text && !text.endsWith("\n")) insert = `\n${insert}`;
  return [{ from, to, text: insert, edit: index }];
}

/**
 * Applies edits that all refer to `text` as read (one revision). Every edit is resolved against the
 * original before anything changes, so earlier edits never shift later line numbers; overlapping
 * edits are refused. Returns the new text and the line ranges each edit wrote (in edit order).
 */
export function applyEdits(text: string, edits: Edit[]): { text: string; changed: LineRange[] } {
  const starts = lineStarts(text);
  const splices = edits.flatMap((e, i) => splicesOf(text, starts, e, i));
  const ordered = [...splices].sort((a, b) => a.from - b.from || a.edit - b.edit);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1] as Splice;
    const cur = ordered[i] as Splice;
    if (cur.from < prev.to || (cur.from === prev.from && cur.to === prev.to))
      throw new ValidationError(
        `Edits ${prev.edit + 1} and ${cur.edit + 1} change the same text; combine them into one edit`,
      );
  }
  let out = "";
  let cursor = 0;
  const placed: { at: number; length: number; edit: number }[] = [];
  for (const s of ordered) {
    out += text.slice(cursor, s.from);
    placed.push({ at: out.length, length: s.text.length, edit: s.edit });
    out += s.text;
    cursor = s.to;
  }
  out += text.slice(cursor);
  const next = lineStarts(out);
  const changed = placed
    .sort((a, b) => a.edit - b.edit || a.at - b.at)
    .map(({ at, length }) => {
      if (!next.length) return { start_line: 1, end_line: 0 };
      const start = at >= out.length ? next.length + 1 : lineAt(next, at);
      return length
        ? { start_line: start, end_line: lineAt(next, at + length - 1) }
        : { start_line: start, end_line: start - 1 };
    });
  return { text: out, changed };
}

/** Lines start..end (1-based, inclusive) prefixed with their numbers, for reading before an edit. */
export function numberedLines(
  text: string,
  start = 1,
  end?: number,
): { text: string; start_line: number; end_line: number; total_lines: number } {
  const lines = text ? text.replace(/\n$/, "").split("\n") : [];
  const total = lines.length;
  const from = Math.max(1, start);
  const to = Math.min(total, end ?? total);
  const width = String(Math.max(to, 1)).length;
  const body = lines
    .slice(from - 1, to)
    .map((l, i) => `${String(from + i).padStart(width, " ")}| ${l}`)
    .join("\n");
  return { text: body, start_line: from, end_line: Math.max(from - 1, to), total_lines: total };
}
