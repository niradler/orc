import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Glob } from "bun";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SkillSource = "builtin" | "user";

export type SkillMeta = {
  name: string;
  description: string;
  tags: string[];
  version: string;
  source: SkillSource;
  path: string;
  dir: string;
  frontmatter: Record<string, unknown>;
};

export type SkillRef = { name: string; path: string };

export type SkillFull = SkillMeta & {
  content: string;
  references: SkillRef[];
};

export type SkillRefContent = SkillRef & { content: string };

export type SkillCache = {
  version: 1;
  builtAt: string;
  skills: SkillMeta[];
};

export type ListSkillsOpts = {
  q?: string | undefined;
  tags?: string[] | undefined;
  source?: SkillSource | undefined;
  reload?: boolean | undefined;
};

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

const KNOWN_FIELDS = new Set(["name", "description", "tags", "version"]);

export function parseFrontmatter(content: string): {
  frontmatter: {
    name: string;
    description: string;
    tags: string[];
    version: string;
    extras: Record<string, unknown>;
  };
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error("Invalid SKILL.md: missing frontmatter");

  const raw = match[1] as string;
  const body = (match[2] as string).trim();

  const fm: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  const tags = (fm.tags ?? "")
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fm)) {
    if (!KNOWN_FIELDS.has(key)) extras[key] = value;
  }

  return {
    frontmatter: {
      name: fm.name ?? "unknown",
      description: fm.description ?? "",
      tags,
      version: fm.version ?? "1.0.0",
      extras,
    },
    body,
  };
}

// ---------------------------------------------------------------------------
// Directories
// ---------------------------------------------------------------------------

const BUILTIN_SKILLS_DIR = resolve(import.meta.dirname, "../../../skills");
const USER_SKILLS_DIR = join(homedir(), ".orc", "skills");
const CACHE_PATH = join(homedir(), ".orc", "skills-cache.json");

export function getBuiltinSkillsDir(): string {
  return BUILTIN_SKILLS_DIR;
}

export function getUserSkillsDir(): string {
  return USER_SKILLS_DIR;
}

// ---------------------------------------------------------------------------
// Reference files
// ---------------------------------------------------------------------------

function listReferenceFiles(skillDir: string): SkillRef[] {
  const refsDir = join(skillDir, "references");
  try {
    if (!statSync(refsDir).isDirectory()) return [];
    return readdirSync(refsDir)
      .filter((f) => statSync(join(refsDir, f)).isFile())
      .map((f) => ({ name: f, path: join(refsDir, f) }));
  } catch {
    return [];
  }
}

function readReferenceFile(skillDir: string, filename: string): SkillRefContent {
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    throw new Error(`Invalid reference filename: ${filename}`);
  }
  const refPath = join(skillDir, "references", filename);
  if (!existsSync(refPath) || !statSync(refPath).isFile()) {
    throw new Error(`Reference file not found: ${filename}`);
  }
  return { name: filename, path: refPath, content: readFileSync(refPath, "utf-8") };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

function scanDirectory(dir: string, source: SkillSource): SkillMeta[] {
  const results: SkillMeta[] = [];
  if (!existsSync(dir)) return results;

  try {
    for (const entry of readdirSync(dir)) {
      const skillDir = join(dir, entry);
      const skillFile = join(skillDir, "SKILL.md");
      try {
        if (!statSync(skillDir).isDirectory()) continue;
        if (!existsSync(skillFile)) continue;
        const content = readFileSync(skillFile, "utf-8");
        const { frontmatter: fm } = parseFrontmatter(content);
        results.push({
          name: fm.name,
          description: fm.description,
          tags: fm.tags,
          version: fm.version,
          source,
          path: skillFile,
          dir: skillDir,
          frontmatter: fm.extras,
        });
      } catch {
        // skip malformed skills
      }
    }
  } catch {
    // dir not readable
  }
  return results;
}

export function scanSkills(): SkillMeta[] {
  const builtin = scanDirectory(BUILTIN_SKILLS_DIR, "builtin");
  const user = scanDirectory(USER_SKILLS_DIR, "user");
  return [...builtin, ...user].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function loadCache(): SkillCache | null {
  try {
    const raw = readFileSync(CACHE_PATH, "utf-8");
    return JSON.parse(raw) as SkillCache;
  } catch {
    return null;
  }
}

function saveCache(cache: SkillCache): void {
  const dir = dirname(CACHE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");
}

export function reloadCache(): SkillCache {
  const skills = scanSkills();
  const cache: SkillCache = { version: 1, builtAt: new Date().toISOString(), skills };
  saveCache(cache);
  return cache;
}

function ensureCache(): SkillCache {
  const cached = loadCache();
  if (cached) return cached;
  return reloadCache();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function listSkills(opts?: ListSkillsOpts): SkillMeta[] {
  const cache = opts?.reload ? reloadCache() : ensureCache();
  let skills = cache.skills;

  if (opts?.source) {
    skills = skills.filter((s) => s.source === opts.source);
  }
  if (opts?.tags && opts.tags.length > 0) {
    const filterTags = opts.tags;
    skills = skills.filter((s) => filterTags.some((t) => s.tags.includes(t)));
  }
  if (opts?.q) {
    const q = opts.q.toLowerCase();
    skills = skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }

  return skills;
}

export function readSkill(name: string, ref?: string): SkillFull | SkillRefContent | null {
  const cache = ensureCache();
  const meta = cache.skills.find((s) => s.name === name);
  if (!meta) return null;

  if (ref) {
    return readReferenceFile(meta.dir, ref);
  }

  const content = readFileSync(meta.path, "utf-8");
  const { body } = parseFrontmatter(content);
  const references = listReferenceFiles(meta.dir);

  return { ...meta, content: body, references };
}

export function createSkill(name: string, content: string): SkillFull {
  if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new Error(`Invalid skill name: ${name}`);
  }

  const skillDir = join(USER_SKILLS_DIR, name);
  const skillFile = join(skillDir, "SKILL.md");

  if (existsSync(skillFile)) {
    throw new Error(`Skill already exists: ${name}`);
  }

  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillFile, content, "utf-8");

  reloadCache();

  const { frontmatter: fm, body } = parseFrontmatter(content);
  const references = listReferenceFiles(skillDir);

  return {
    name: fm.name,
    description: fm.description,
    tags: fm.tags,
    version: fm.version,
    source: "user",
    path: skillFile,
    dir: skillDir,
    frontmatter: fm.extras,
    content: body,
    references,
  };
}
