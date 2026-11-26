import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ErrorCode,
  ListResourcesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { parseMarkdownFrontmatter } from "@orc/core/markdown-frontmatter";
import {
  listSkillFiles,
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_FILES,
  readSkillFile,
  validateSkillPath,
} from "@orc/core/skill-files";
import type { SkillRefContent } from "@orc/core/skill-service";
import { getSqlite } from "@orc/db/client";
import { SkillHistory, type SkillListItem } from "@orc/db/skill-history";
import { z } from "zod";

export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";

const URI_PREFIX = "skill://";
const TTL_MS = 300_000;
const CACHE_SCOPE = "private";
const PAGE_SIZE = 50;
const MANIFEST_CACHE_MAX = 256;

const SkillsListRequestSchema = z.object({
  method: z.literal("skills/list"),
  params: z.object({ cursor: z.string().optional() }).optional(),
});
const SkillsGetRequestSchema = z.object({
  method: z.literal("skills/get"),
  params: z.object({ uri: z.string().min(1) }),
});
const DirectoryReadRequestSchema = z.object({
  method: z.literal("resources/directory/read"),
  params: z.object({ uri: z.string().min(1), cursor: z.string().optional() }),
});

type ManifestFile = { uri: string; digest: string; size: number };
type SkillEntry = {
  uri: string;
  frontmatter: Record<string, unknown>;
  resources: ManifestFile[];
};
type ServedBytes = { content: string; encoding: "utf8" | "base64"; bytes: Buffer };

// Shared across per-request stateless HTTP server instances; invalidated by
// stat mtime/size plus overlay mutation id.
const manifestCache = new Map<string, { fingerprint: string; entry: SkillEntry }>();

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "pdf",
  "zip",
  "gz",
  "wasm",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "mp3",
  "mp4",
]);

function mimeFor(path: string, encoding?: "utf8" | "base64"): string {
  if (encoding === "base64") return "application/octet-stream";
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return "application/octet-stream";
  switch (ext) {
    case "md":
      return "text/markdown";
    case "json":
      return "application/json";
    case "yaml":
    case "yml":
      return "text/yaml";
    case "html":
      return "text/html";
    case "js":
    case "mjs":
      return "text/javascript";
    case "ts":
      return "application/typescript";
    case "sh":
      return "application/x-sh";
    case "csv":
      return "text/csv";
    default:
      return "text/plain";
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const parsed = z
      .object({ offset: z.number().int().min(0) })
      .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return parsed.offset;
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `Invalid cursor: ${cursor}`);
  }
}

function cacheFields() {
  return { resultType: "complete" as const, ttlMs: TTL_MS, cacheScope: CACHE_SCOPE };
}

export interface SkillResourcesOptions {
  projectScopes?: readonly { id: string; name: string }[] | undefined;
}

export function registerSkillResources(server: Server, options: SkillResourcesOptions = {}): void {
  const history = new SkillHistory(getSqlite());
  const projectIds = options.projectScopes?.map((p) => p.id);

  function scopeFor(name: string): string | null {
    return projectIds ? history.preferredProject(name, projectIds) : null;
  }

  function discoverableSkills(): SkillListItem[] {
    return history
      .list(null, projectIds ? { projectIds } : {})
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function accessibleSkills(): SkillListItem[] {
    return history
      .list(null, { ...(projectIds ? { projectIds } : {}), include_hidden: true })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function servedFile(meta: SkillListItem, ref: string): ServedBytes | null {
    const scope = scopeFor(meta.name);
    let result: SkillRefContent | null;
    try {
      if (ref === "SKILL.md") {
        result = history.read(meta.name, scope, "SKILL.md") as SkillRefContent | null;
      } else {
        if (!history.visible(meta.name, scope)) return null;
        result = readSkillFile(dirname(meta.path), ref, false);
      }
    } catch {
      return null;
    }
    if (!result) return null;
    const bytes = Buffer.from(result.content, result.encoding === "base64" ? "base64" : "utf8");
    return { content: result.content, encoding: result.encoding, bytes };
  }

  function fingerprint(meta: SkillListItem, files: { name: string; path: string }[]): string {
    const parts = [meta.mutation?.id ?? "", String(meta.mutation?.updated_at ?? "")];
    for (const path of [meta.path, ...files.map((f) => f.path)]) {
      const stat = statSync(path, { throwIfNoEntry: false });
      parts.push(`${path}:${stat ? `${stat.mtimeMs}:${stat.size}` : "gone"}`);
    }
    return parts.join("|");
  }

  function skillEntry(meta: SkillListItem): SkillEntry | null {
    const skillDir = dirname(meta.path);
    let files: { name: string; path: string }[];
    try {
      files = listSkillFiles(skillDir);
    } catch {
      return null;
    }
    if (1 + files.length > MAX_SKILL_FILES) return null;
    const cacheKey = `${meta.path}:${scopeFor(meta.name) ?? "global"}:${meta.name}`;
    const fp = fingerprint(meta, files);
    const cached = manifestCache.get(cacheKey);
    if (cached && cached.fingerprint === fp) return cached.entry;

    const entrySkill = servedFile(meta, "SKILL.md");
    if (!entrySkill) return null;
    let frontmatter: Record<string, unknown>;
    try {
      frontmatter = parseMarkdownFrontmatter(entrySkill.content).fields;
    } catch {
      return null;
    }
    const uri = `${URI_PREFIX}${meta.name}/SKILL.md`;
    const resources: ManifestFile[] = [
      { uri, digest: sha256(entrySkill.bytes), size: entrySkill.bytes.length },
    ];
    let total = entrySkill.bytes.length;
    for (const file of files) {
      const served = servedFile(meta, file.name);
      if (!served) return null;
      total += served.bytes.length;
      if (total > MAX_SKILL_BUNDLE_BYTES) return null;
      resources.push({
        uri: `${URI_PREFIX}${meta.name}/${file.name}`,
        digest: sha256(served.bytes),
        size: served.bytes.length,
      });
    }
    const entry: SkillEntry = { uri, frontmatter, resources };
    if (manifestCache.size >= MANIFEST_CACHE_MAX) manifestCache.clear();
    manifestCache.set(cacheKey, { fingerprint: fp, entry });
    return entry;
  }

  function resolveUri(
    uri: string,
    catalog: readonly SkillListItem[],
  ): { meta: SkillListItem; name: string; ref: string } | null {
    if (!uri.startsWith(URI_PREFIX) || uri.endsWith("/")) return null;
    const path = uri.slice(URI_PREFIX.length);
    const candidates = [...catalog].sort((a, b) => b.name.length - a.name.length);
    for (const meta of candidates) {
      const name = meta.name;
      if (path === name) return { meta, name, ref: "" };
      if (!path.startsWith(`${name}/`)) continue;
      const ref = path.slice(name.length + 1);
      try {
        validateSkillPath(ref);
      } catch {
        return null;
      }
      return { meta, name, ref };
    }
    return null;
  }

  function entryForUri(uri: string): SkillEntry {
    const resolved = resolveUri(uri, accessibleSkills());
    const entry = resolved ? skillEntry(resolved.meta) : null;
    if (!resolved || !entry || resolved.ref !== "SKILL.md" || entry.uri !== uri)
      throw new McpError(ErrorCode.InvalidParams, `Unknown skill: ${uri}`);
    return entry;
  }

  server.setRequestHandler(SkillsListRequestSchema, async (request) => {
    const items = discoverableSkills();
    const offset = decodeCursor(request.params?.cursor);
    const page = items.slice(offset, offset + PAGE_SIZE);
    const skills = page
      .map((meta) => skillEntry(meta))
      .filter((entry): entry is SkillEntry => entry !== null);
    const nextOffset = offset + PAGE_SIZE;
    return {
      ...cacheFields(),
      skills,
      ...(nextOffset < items.length ? { nextCursor: encodeCursor(nextOffset) } : {}),
    };
  });

  server.setRequestHandler(SkillsGetRequestSchema, async (request) => ({
    ...cacheFields(),
    skill: entryForUri(request.params.uri),
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const all = discoverableSkills().flatMap((meta) => {
      const entry = skillEntry(meta);
      if (!entry) return [];
      return entry.resources.map((file) => ({
        uri: file.uri,
        name: file.uri.slice(URI_PREFIX.length),
        mimeType: mimeFor(file.uri),
      }));
    });
    const offset = decodeCursor(request.params?.cursor);
    const page = all.slice(offset, offset + PAGE_SIZE);
    const nextOffset = offset + PAGE_SIZE;
    return {
      resources: page,
      ...(nextOffset < all.length ? { nextCursor: encodeCursor(nextOffset) } : {}),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const resolved = resolveUri(uri, accessibleSkills());
    if (!resolved?.ref) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
    }
    // Enforce exact URI paths instead of falling back to legacy references/<name>.
    if (resolved.ref !== "SKILL.md") {
      let listed: { name: string; path: string }[];
      try {
        listed = listSkillFiles(dirname(resolved.meta.path));
      } catch {
        throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
      }
      if (!listed.some((file) => file.name === resolved.ref)) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
      }
    }
    const served = servedFile(resolved.meta, resolved.ref);
    if (!served) throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
    history.recordRead(
      resolved.name,
      scopeFor(resolved.name),
      "mcp",
      resolved.ref === "SKILL.md" ? undefined : resolved.ref,
    );
    const mimeType = mimeFor(resolved.ref, served.encoding);
    return {
      ...cacheFields(),
      contents: [
        served.encoding === "base64"
          ? { uri, mimeType, blob: served.content }
          : { uri, mimeType, text: served.content },
      ],
    };
  });

  server.setRequestHandler(DirectoryReadRequestSchema, async (request) => {
    const { uri } = request.params;
    const resolved = resolveUri(uri, accessibleSkills());
    if (!resolved) throw new McpError(ErrorCode.InvalidParams, `Unknown directory: ${uri}`);
    const dirRef = uri === `${URI_PREFIX}${resolved.name}` ? "" : resolved.ref;
    let files: { name: string; path: string }[];
    try {
      files = listSkillFiles(dirname(resolved.meta.path));
    } catch {
      throw new McpError(ErrorCode.InvalidParams, `Unknown directory: ${uri}`);
    }
    const prefix = dirRef ? `${dirRef}/` : "";
    const children = new Map<string, { uri: string; name: string; mimeType: string }>();
    const names = ["SKILL.md", ...files.map((f) => f.name)];
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length);
      const slash = rest.indexOf("/");
      const childName = slash === -1 ? rest : rest.slice(0, slash);
      const childUri = `${URI_PREFIX}${resolved.name}/${prefix}${childName}`;
      children.set(childName, {
        uri: childUri,
        name: childName,
        mimeType: slash === -1 ? mimeFor(name, "utf8") : "inode/directory",
      });
    }
    if (dirRef && children.size === 0) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown directory: ${uri}`);
    }
    const all = [...children.values()].sort((a, b) => a.name.localeCompare(b.name));
    const offset = decodeCursor(request.params?.cursor);
    const page = all.slice(offset, offset + PAGE_SIZE);
    const nextOffset = offset + PAGE_SIZE;
    return {
      ...cacheFields(),
      resources: page,
      ...(nextOffset < all.length ? { nextCursor: encodeCursor(nextOffset) } : {}),
    };
  });
}
