import type { ParsedBlock } from "@orc/core/kb";

// Page/slide markers emitted by ORC parser adapters: `<!-- page: N -->`.
const PAGE = /^<!--\s*(?:page|slide number):\s*(\d+)\s*-->$/i;
const SHEET = /^<!--\s*sheet:\s*(.+?)\s*-->$/i;
const FENCE = /^(`{3,}|~{3,})/;

const clean = (s: string) => s.replace(/\*\*|__|\\(?=[\\`*_{}[\]()#+\-.!|])/g, "").trim();
const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map(clean);

/** Strips a leading YAML frontmatter block (Obsidian-style notes). */
export function stripFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  if (end < 0) return md;
  const nl = md.indexOf("\n", end + 4);
  return nl < 0 ? "" : md.slice(nl + 1);
}

/** Markdown -> ORC blocks. The single normalizer every parser's Markdown goes through. */
export function markdownToBlocks(source: string): ParsedBlock[] {
  const lines = stripFrontmatter(source.replace(/\r\n?/g, "\n")).split("\n");
  const blocks: ParsedBlock[] = [];
  let path: [number, string][] = [];
  let page: number | undefined;
  let sheet: string | undefined;
  let para: string[] = [];
  const locator = () =>
    page !== undefined || sheet !== undefined
      ? { locator: { ...(page !== undefined ? { page } : {}), ...(sheet ? { sheet } : {}) } }
      : {};
  const push = (b: Pick<ParsedBlock, "kind" | "text"> & Partial<ParsedBlock>) =>
    blocks.push({ ...b, heading_path: path.map((h) => h[1]), ...locator() });
  const flush = () => {
    if (para.length) push({ kind: "paragraph", text: clean(para.join(" ")) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] ?? "").trim();
    const pm = t.match(PAGE);
    if (pm) {
      flush();
      page = Number(pm[1]);
      continue;
    }
    const sm = t.match(SHEET);
    if (sm) {
      flush();
      sheet = sm[1];
      continue;
    }
    if (!t || /^<!--.*-->$/.test(t)) {
      flush();
      continue;
    }
    const fence = t.match(FENCE)?.[1];
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !(lines[i] ?? "").trim().startsWith(fence); i++)
        body.push(lines[i] ?? "");
      push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h?.[1] && h[2] !== undefined) {
      flush();
      const level = h[1].length;
      const text = clean(h[2].replace(/\s+#+$/, ""));
      path = [...path.filter((x) => x[0] < level), [level, text]];
      push({ kind: "heading", level, text });
      continue;
    }
    if (t.startsWith("|")) {
      flush();
      const rows: string[][] = [];
      for (; i < lines.length && (lines[i] ?? "").trim().startsWith("|"); i++) {
        const cells = splitRow(lines[i] ?? "");
        // Separator rows carry no content; some converters emit an all-empty header row.
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c)) && cells.some(Boolean)) rows.push(cells);
      }
      i--;
      if (rows.length)
        push({ kind: "table", text: rows.map((r) => r.join(" | ")).join("\n"), rows });
      continue;
    }
    const li = t.match(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/);
    if (li) {
      flush();
      push({ kind: "list_item", text: clean(li[1] ?? "") });
      continue;
    }
    para.push(t.replace(/^>\s?/, ""));
  }
  flush();
  return blocks.filter((b) => b.text || b.rows?.length);
}

export function outline(blocks: ParsedBlock[]): { level: number; text: string; block: number }[] {
  return blocks.flatMap((b, block) =>
    b.kind === "heading" ? [{ level: b.level ?? 1, text: b.text, block }] : [],
  );
}

/**
 * Link targets: `[[Target]]`, `[[Target|alias]]`, `[[Target#Heading]]` and relative Markdown
 * links to .md files. Targets are normalized to a lowercase key without heading or extension;
 * resolution against titles/paths happens in the catalog.
 */
export function extractLinks(md: string): string[] {
  const body = md.replace(/(`{3,}|~{3,})[\s\S]*?\1/g, "").replace(/`[^`\n]*`/g, "");
  const out = new Set<string>();
  for (const m of body.matchAll(/(?<!!)\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g)) {
    const key = linkKey(m[1] ?? "");
    if (key) out.add(key);
  }
  for (const m of body.matchAll(/(?<!!)\[[^\]\n]*\]\(([^)\s]+\.md)(?:#[^)\s]*)?\)/gi)) {
    const target = decodeURIComponent(m[1] ?? "");
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) continue;
    const key = linkKey(target.replace(/^(\.\/)+/, ""));
    if (key) out.add(key);
  }
  return [...out].slice(0, 500);
}

export function linkKey(target: string): string {
  return target.trim().replace(/\.md$/i, "").replace(/\s+/g, " ").toLowerCase();
}

export function firstHeading(md: string): string | undefined {
  return markdownToBlocks(md).find((b) => b.kind === "heading")?.text;
}
