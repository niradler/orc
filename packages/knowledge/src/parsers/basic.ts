/**
 * Built-in lightweight parser (no Python, ships in every distribution). Converts to Markdown and
 * lets the shared normalizer derive blocks, so every parser produces the same block shapes.
 * Recovers text, DOCX/HTML headings, Office/spreadsheet tables and PDF page/slide locators;
 * scans and PDF layout (headings, table structure) need the optional Docling parser.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PARSED_DOCUMENT_SCHEMA_VERSION, type ParsedDocument } from "@orc/core/kb";
import { markdownToBlocks } from "../markdown.js";

export const BASIC_PARSER_ID = "basic";
export const BASIC_PARSER_VERSION = "1.0.0";
export const BASIC_FORMATS = [
  "md",
  "markdown",
  "txt",
  "csv",
  "html",
  "htm",
  "docx",
  "pptx",
  "xlsx",
  "pdf",
];

const MAX_SHEET_ROWS = 20_000;
/** Office files are zips; refuse archives that would expand past this before any library opens them. */
export const ZIP_LIMITS = { maxEntries: 10_000, maxExpandedBytes: 512 * 2 ** 20 };

/**
 * Inflate every entry once, counting real output bytes (declared sizes can lie), and stop as
 * soon as the archive exceeds the limits, so a zip bomb fails fast instead of exhausting memory.
 */
export async function assertZipWithinLimits(data: Uint8Array, limits = ZIP_LIMITS) {
  const { Unzip, UnzipInflate } = await import("fflate");
  let entries = 0;
  let expanded = 0;
  const unzip = new Unzip((file) => {
    if (++entries > limits.maxEntries)
      throw new Error(`archive has more than ${limits.maxEntries} entries`);
    file.ondata = (err, chunk) => {
      if (err) throw err;
      expanded += chunk.length;
      if (expanded > limits.maxExpandedBytes)
        throw new Error(`archive expands past ${Math.round(limits.maxExpandedBytes / 2 ** 20)} MB`);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  const step = 1 << 20;
  for (let i = 0; i < data.length; i += step)
    unzip.push(data.subarray(i, i + step), i + step >= data.length);
}

export const mdTable = (rows: string[][]) => {
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) =>
    Array.from({ length: width }, (_, i) =>
      (r[i] ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim(),
    );
  const [head = [], ...body] = rows.map(pad);
  return [
    `| ${head.join(" | ")} |`,
    `|${" --- |".repeat(width)}`,
    ...body.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
};

/**
 * Head metadata never reaches the text. A page titled only by <title> gets that title as its
 * leading heading, so converted pages start with their title like Markdown documents do.
 */
export async function htmlToMarkdown(html: string) {
  const { default: TurndownService } = await import("turndown");
  const td = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
  });
  // The parser drops <head> but keeps its children, so <title> would otherwise become body text.
  td.remove(["script", "style", "noscript", "head", "title", "meta", "link", "template"]);
  td.addRule("table", {
    filter: "table",
    replacement: (_content, node) => {
      // turndown's DOM (domino) NodeList is not iterable.
      type El = { querySelectorAll(s: string): ArrayLike<El>; textContent: string | null };
      const rows = Array.from((node as unknown as El).querySelectorAll("tr")).map((tr) =>
        Array.from(tr.querySelectorAll("th,td")).map((c) => c.textContent ?? ""),
      );
      return `\n\n${mdTable(rows)}\n\n`;
    },
  });
  const body = td.turndown(html);
  const title = elementText(html, "title");
  if (!title || markdownToBlocks(body).some((b) => b.kind === "heading" && b.level === 1))
    return body;
  return `# ${title}\n\n${body}`;
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, "&");

const elementText = (html: string, tag: "h1" | "title") => {
  const inner = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"))?.[1];
  const text =
    inner &&
    decode(inner.replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
  return text || undefined;
};

/** The title an HTML page gives itself: its first H1, else its <title>, as Markdown files use H1. */
export function htmlTitle(html: string): string | undefined {
  return elementText(html, "h1") ?? elementText(html, "title");
}
const runs = (xml: string) =>
  [...xml.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<a:br\b[^>]*\/>/g)]
    .map((m) => (m[1] === undefined ? " " : decode(m[1])))
    .join("")
    .trim();
const paras = (xml: string) =>
  [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)].map((m) => runs(m[1] ?? "")).filter(Boolean);

/** Slide XML in reading order; titles become headings, tables become Markdown tables. */
async function pptxToMarkdown(data: Uint8Array, warnings: string[]) {
  const { unzipSync, strFromU8 } = await import("fflate");
  const files = unzipSync(data, {
    filter: (f) =>
      /^ppt\/(slides\/slide\d+\.xml|presentation\.xml|_rels\/presentation\.xml\.rels)$/.test(
        f.name,
      ),
  });
  const slideNo = (name: string) => Number(name.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
  // Presentation order comes from presentation.xml's sldIdLst (file numbers can be out of order).
  let order = Object.keys(files)
    .filter((n) => n.startsWith("ppt/slides/"))
    .sort((a, b) => slideNo(a) - slideNo(b));
  const pres = files["ppt/presentation.xml"];
  const rels = files["ppt/_rels/presentation.xml.rels"];
  if (pres && rels) {
    const target = new Map(
      [
        ...strFromU8(rels).matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g),
      ].map((m) => [m[1], `ppt/${(m[2] ?? "").replace(/^\/?ppt\//, "")}`]),
    );
    const listed = [...strFromU8(pres).matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)]
      .map((m) => target.get(m[1]))
      .filter((n): n is string => !!n && n in files);
    if (listed.length) order = listed;
  }
  const out: string[] = [];
  order.forEach((name, i) => {
    const file = files[name];
    if (!file) return;
    const xml = strFromU8(file);
    if (/<p:sld\b[^>]*\bshow="0"/.test(xml)) return;
    out.push(`<!-- page: ${i + 1} -->`);
    let titled = false;
    for (const m of xml.matchAll(
      /<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>|<p:graphicFrame\b[^>]*>([\s\S]*?)<\/p:graphicFrame>/g,
    )) {
      if (m[1] !== undefined) {
        const isTitle = /<p:ph\b[^>]*type="(?:title|ctrTitle)"/.test(m[1]);
        for (const p of paras(m[1])) {
          out.push(isTitle && !titled ? `# ${p}` : p, "");
          if (isTitle) titled = true;
        }
      } else if (m[2]?.includes("<a:tbl>")) {
        const rows = [...m[2].matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)].map((tr) =>
          [...tr[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map((tc) => paras(tc[0]).join(" ")),
        );
        out.push(mdTable(rows), "");
      }
    }
  });
  if (!order.length) warnings.push("no slides found");
  return out.join("\n");
}

async function sheetToMarkdown(data: Buffer, warnings: string[], type: "buffer" | "string") {
  const XLSX = await import("xlsx");
  const wb =
    type === "string"
      ? XLSX.read(data.toString("utf8"), { type: "string", raw: true })
      : XLSX.read(data, { type: "buffer", dense: true });
  return wb.SheetNames.map((name) => {
    const sheet = wb.Sheets[name];
    if (!sheet) return "";
    let rows = XLSX.utils
      .sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" })
      .map((r) => r.map((c) => String(c ?? "")))
      .filter((r) => r.some((c) => c.trim()));
    if (rows.length > MAX_SHEET_ROWS) {
      warnings.push(`sheet "${name}" truncated to ${MAX_SHEET_ROWS} rows`);
      rows = rows.slice(0, MAX_SHEET_ROWS);
    }
    const heading = wb.SheetNames.length > 1 || type === "buffer" ? `## ${name}\n\n` : "";
    return `<!-- sheet: ${name.replace(/-->/g, "")} -->\n${heading}${mdTable(rows)}`;
  }).join("\n\n");
}

async function pdfToMarkdown(data: Buffer, warnings: string[]) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text, totalPages } = await extractText(pdf, { mergePages: false });
  const pages = text as string[];
  const chars = pages.reduce((n, t) => n + t.replace(/\s/g, "").length, 0);
  if (totalPages && chars / totalPages < 20)
    warnings.push("little or no text layer (scanned?); install the Docling parser for OCR");
  return pages.map((t, i) => `<!-- page: ${i + 1} -->\n${t.replace(/\n/g, "\n\n")}`).join("\n\n");
}

export async function parseBasic(path: string, ext: string): Promise<ParsedDocument> {
  const t0 = performance.now();
  const buf = readFileSync(path);
  const warnings: string[] = [];
  let markdown = "";
  let status: ParsedDocument["status"] = "failed";
  try {
    if (ext === "docx" || ext === "pptx" || ext === "xlsx") await assertZipWithinLimits(buf);
    if (ext === "docx") {
      const { default: mammoth } = await import("mammoth");
      const res = await mammoth.convertToHtml(
        { buffer: buf },
        { styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"] },
      );
      markdown = await htmlToMarkdown(res.value);
    } else if (ext === "html" || ext === "htm")
      markdown = await htmlToMarkdown(buf.toString("utf8"));
    else if (ext === "pptx") markdown = await pptxToMarkdown(new Uint8Array(buf), warnings);
    else if (ext === "xlsx") markdown = await sheetToMarkdown(buf, warnings, "buffer");
    else if (ext === "csv") markdown = await sheetToMarkdown(buf, warnings, "string");
    else if (ext === "pdf") markdown = await pdfToMarkdown(buf, warnings);
    else if (ext === "md" || ext === "markdown" || ext === "txt") markdown = buf.toString("utf8");
    else warnings.push(`unsupported format .${ext}`);
    const hasText = markdown.replace(/<!--[^>]*-->/g, "").trim().length > 0;
    status = hasText ? (warnings.length ? "partial" : "ok") : "failed";
    if (!hasText && !warnings.length) warnings.push("no text extracted");
  } catch (e) {
    warnings.push(`${(e as Error).name}: ${(e as Error).message}`.slice(0, 500));
    status = "failed";
  }
  return {
    schema_version: PARSED_DOCUMENT_SCHEMA_VERSION,
    parser: { id: BASIC_PARSER_ID, version: BASIC_PARSER_VERSION, options: {} },
    source_sha256: createHash("sha256").update(buf).digest("hex"),
    status,
    blocks: status === "failed" ? [] : markdownToBlocks(markdown),
    markdown: status === "failed" ? "" : markdown,
    warnings,
    timings_ms: { convert: Math.round(performance.now() - t0) },
    peak_rss_mb: Math.round(process.memoryUsage().rss / 2 ** 20),
  };
}
