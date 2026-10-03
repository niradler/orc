export type DiffLine = {
  id: number;
  text: string;
  kind: "add" | "remove" | "hunk" | "meta" | "context";
  old: number | null;
  next: number | null;
};

export function diffLines(diff: string): DiffLine[] {
  let old = 0;
  let next = 0;
  let inHunk = false;
  let offset = 0;
  return diff.split("\n").map((text) => {
    const id = offset;
    offset += text.length + 1;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      inHunk = true;
      return { id, text, kind: "hunk", old: null, next: null };
    }
    if (text.startsWith("diff --git")) inHunk = false;
    if (inHunk && text.startsWith("+")) return { id, text, kind: "add", old: null, next: next++ };
    if (inHunk && text.startsWith("-")) return { id, text, kind: "remove", old: old++, next: null };
    if (inHunk && text.startsWith(" "))
      return { id, text, kind: "context", old: old++, next: next++ };
    return { id, text, kind: "meta", old: null, next: null };
  });
}
