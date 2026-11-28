import { basename, dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Open Knowledge Format (OKF v0.3) support. A bundle is a directory of Markdown concepts with
 * YAML frontmatter; ORC keeps Markdown as the canonical document and reads the fields it models
 * (title, description, tags, type) while leaving everything else in the content for round-trip.
 */
export const OKF_VERSION = "0.3";
export const OKF_RESERVED = new Set(["index.md", "log.md"]);

export type Frontmatter = Record<string, unknown>;

export type ParsedFrontmatter = {
  data: Frontmatter | null;
  body: string;
  /** The exact YAML between the fences, for round-trip understanding. */
  raw: string | null;
};

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseFrontmatter(markdown: string): ParsedFrontmatter {
  const match = markdown.match(FRONTMATTER);
  if (!match?.[1]) return { data: null, body: markdown, raw: null };
  let data: Frontmatter | null = null;
  try {
    const value = parseYaml(match[1]);
    data =
      value && typeof value === "object" && !Array.isArray(value) ? (value as Frontmatter) : null;
  } catch {
    data = null;
  }
  return { data, body: markdown.slice(match[0].length), raw: match[1] };
}

function strings(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value))
    return value
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean);
  return [];
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export type OkfFields = {
  title?: string | undefined;
  description?: string | undefined;
  tags: string[];
  type?: string | undefined;
  timestamp?: string | undefined;
  verified?: boolean | undefined;
  generated?: string | undefined;
  status?: string | undefined;
  stale_after?: string | undefined;
  /** Frontmatter keys ORC does not model; preserved in the content. */
  extra: Frontmatter;
};

const MODELLED = new Set([
  "title",
  "description",
  "tags",
  "type",
  "timestamp",
  "verified",
  "generated",
  "status",
  "stale_after",
]);

/** Reads the OKF fields ORC understands without changing the stored Markdown. */
export function okfFields(markdown: string): OkfFields {
  const { data } = parseFrontmatter(markdown);
  const fm = data ?? {};
  const type = text(fm.type);
  const title = text(fm.title);
  const description = text(fm.description);
  const timestamp = text(fm.timestamp);
  const generated = text(fm.generated);
  const status = text(fm.status);
  const staleAfter = text(fm.stale_after);
  const extra = Object.fromEntries(Object.entries(fm).filter(([key]) => !MODELLED.has(key)));
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    tags: [...new Set(strings(fm.tags))],
    ...(type ? { type } : {}),
    ...(timestamp ? { timestamp } : {}),
    ...(fm.verified === true || text(fm.verified) ? { verified: true } : {}),
    ...(generated ? { generated } : {}),
    ...(status ? { status } : {}),
    ...(staleAfter ? { stale_after: staleAfter } : {}),
    extra,
  };
}

/** Labels an OKF concept inherits (`tags` plus a `type` label). */
export function okfLabels(markdown: string): string[] {
  const fields = okfFields(markdown);
  return [...new Set([...fields.tags, ...(fields.type ? [fields.type] : [])])].slice(0, 30);
}

/** Reserved names are bundle navigation/history, not concepts. */
export function isOkfReserved(path: string): boolean {
  return OKF_RESERVED.has(basename(path).toLowerCase());
}

/** Ingests frontmatter into the native fields only where the caller supplied nothing. */
export function withOkfDefaults(
  markdown: string,
  input: {
    title?: string | undefined;
    description?: string | undefined;
    labels?: string[] | undefined;
  },
  fallbackTitle: string,
): { title: string; description: string; labels: string[] } {
  const fields = okfFields(markdown);
  const title = input.title?.trim() || fields.title || fallbackTitle;
  const description = input.description?.trim() || fields.description || "";
  const labels = [...new Set([...(input.labels ?? []), ...okfLabels(markdown)])].slice(0, 30);
  return { title, description, labels };
}

export type OkfDocument = {
  path: string;
  title: string;
  description: string;
  labels: string[];
  content: string;
};

/**
 * Re-emits a document with native fields authoritative and unknown frontmatter preserved.
 * The body is kept exactly, so an ingest → export round-trip keeps what ORC does not model.
 */
export function exportDocument(doc: OkfDocument): string {
  const parsed = parseFrontmatter(doc.content);
  const original = parsed.data ?? {};
  const type = text(original.type);
  const tags = doc.labels.filter((label) => label !== type);
  const frontmatter: Frontmatter = {
    ...original,
    title: doc.title,
    ...(doc.description ? { description: doc.description } : {}),
    ...(tags.length ? { tags } : {}),
  };
  if (!doc.description) delete frontmatter.description;
  if (!tags.length) delete frontmatter.tags;
  return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n${parsed.body.replace(/^\r?\n/, "")}`;
}

export type OkfBundleFile = { path: string; content: string };

function folderOf(path: string): string {
  const folder = dirname(path);
  return folder === "." ? "" : folder.split("\\").join("/");
}

function indexOf(files: Map<string, string>, folder: string, kbName: string): string {
  const prefix = folder ? `${folder}/` : "";
  const direct = new Map<string, string>();
  const folders = new Map<string, number>();
  for (const path of files.keys()) {
    if (path === "index.md" || path === "log.md") continue;
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const [head, ...tail] = rest.split("/");
    if (!head) continue;
    if (tail.length) folders.set(head, (folders.get(head) ?? 0) + 1);
    else direct.set(path, files.get(path) ?? "");
  }
  const title = folder ? basename(folder) : kbName;
  const lines = [
    "---",
    stringifyYaml({ title, okf_version: OKF_VERSION }).trimEnd(),
    "---",
    "",
    `# ${title}`,
    "",
  ];
  for (const [name, count] of [...folders].sort(([a], [b]) => a.localeCompare(b)))
    lines.push(`- [${name}](${encodeURI(`${name}/index.md`)}) · ${count} documents`);
  for (const [path, content] of [...direct].sort(([a], [b]) => a.localeCompare(b))) {
    const docTitle = parseFrontmatter(content).data?.title;
    lines.push(
      `- [${typeof docTitle === "string" ? docTitle : basename(path, ".md")}](${encodeURI(basename(path))})`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** Builds a conformant OKF directory: one file per concept, folder indexes, root index and log. */
export function buildOkfBundle(
  docs: OkfDocument[],
  log: string[] = [],
  kbName = "Knowledge",
): OkfBundleFile[] {
  const files = new Map<string, string>();
  for (const doc of docs) {
    const path = doc.path.replace(/^\/+/, "");
    if (!path || isOkfReserved(path)) continue;
    files.set(path, exportDocument({ ...doc, path }));
  }
  const folders = new Set<string>([""]);
  for (const path of files.keys()) {
    const parts = folderOf(path).split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  const out: OkfBundleFile[] = [];
  for (const folder of [...folders].sort((a, b) => a.localeCompare(b))) {
    out.push({
      path: folder ? `${folder}/index.md` : "index.md",
      content: indexOf(files, folder, kbName),
    });
  }
  for (const [path, content] of files) out.push({ path, content });
  out.push({
    path: "log.md",
    content: [
      "---",
      stringifyYaml({ title: "Knowledge log", okf_version: OKF_VERSION }).trimEnd(),
      "---",
      "",
      "# Knowledge log",
      "",
      ...(log.length ? log.map((line) => `- ${line}`) : ["- No recorded revisions."]),
      "",
    ].join("\n"),
  });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
