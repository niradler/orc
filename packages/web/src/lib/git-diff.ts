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

export type DiffPair = {
  id: string;
  left: DiffLine | null;
  right: DiffLine | null;
  full: DiffLine | null;
};

export function pairDiffLines(lines: DiffLine[]): DiffPair[] {
  const result: DiffPair[] = [];
  for (let index = 0; index < lines.length; ) {
    const line = lines[index];
    if (!line) break;
    if (line.kind === "add" || line.kind === "remove") {
      const removed: DiffLine[] = [];
      const added: DiffLine[] = [];
      while (lines[index]?.kind === "remove" || lines[index]?.kind === "add") {
        const change = lines[index];
        if (!change) break;
        if (change.kind === "remove") removed.push(change);
        else added.push(change);
        index++;
      }
      for (let pair = 0; pair < Math.max(removed.length, added.length); pair++)
        result.push({
          id: `${line.id}:${pair}`,
          left: removed[pair] ?? null,
          right: added[pair] ?? null,
          full: null,
        });
    } else {
      result.push({
        id: String(line.id),
        left: line.kind === "context" ? line : null,
        right: line.kind === "context" ? line : null,
        full: line.kind === "context" ? null : line,
      });
      index++;
    }
  }
  return result;
}
