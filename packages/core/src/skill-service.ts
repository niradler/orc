import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ValidationError } from "./errors.js";
import { parseMarkdownFrontmatter } from "./markdown-frontmatter.js";
import { getPackagesDir } from "./package-paths.js";
import { parsePluginManifest } from "./plugin-service.js";
import {
  listSkillFiles,
  prepareSkillFiles,
  readSkillFile,
  type SkillFileInput,
  type SkillRef,
  type SkillRefContent,
  validateSkillPath,
} from "./skill-files.js";

export type { SkillFileInput, SkillRef, SkillRefContent } from "./skill-files.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SkillSource = "builtin" | "user";

export type SkillMeta = {
  name: string;
  description: string;
  source: SkillSource;
  path: string;
  metadata: Record<string, unknown>;
};

export type SkillFull = SkillMeta & {
  content: string;
  references: SkillRef[];
  files: SkillRef[];
};

export function renderSkillInstructions(skill: SkillFull): string {
  const files = skill.files.map((file) => `- ${file.name} (${file.path})`).join("\n");
  return `${skill.content}\n\nSkill entry point: ${skill.path}\nResolve relative paths from this skill directory. Load supporting files only when needed using skill_read with name "${skill.name}" and ref set to the relative path, or read the local file.\n${files}`;
}

export type SkillIssue = { path: string; error: string };

export type SkillWarning = { path: string; message: string };

export type SkillCache = {
  version: 4;
  builtAt: string;
  skills: SkillMeta[];
  broken: SkillIssue[];
  warnings: SkillWarning[];
};

export type ListSkillsOpts = {
  q?: string | undefined;
  source?: SkillSource | undefined;
  reload?: boolean | undefined;
};

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

const HEADER_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

export function validateSkillName(name: string): void {
  const normalized = name.normalize("NFKC");
  if (
    !normalized ||
    [...normalized].length > 64 ||
    normalized !== normalized.toLowerCase() ||
    !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(normalized)
  ) {
    throw new ValidationError(
      "Invalid skill name: use 1-64 lowercase letters or numbers separated by single hyphens",
    );
  }
  validateSkillPath(name);
}

export function parseFrontmatter(content: string): {
  frontmatter: {
    name: string;
    description: string;
    metadata: Record<string, unknown>;
  };
  body: string;
} {
  const { fields: fm, body } = parseMarkdownFrontmatter(content);
  for (const key of Object.keys(fm)) {
    if (!HEADER_FIELDS.has(key))
      throw new ValidationError(
        `Unexpected SKILL.md field: ${key}. Put custom fields under metadata.`,
      );
  }
  if (typeof fm.name !== "string")
    throw new ValidationError("SKILL.md name is required and must be a string");
  validateSkillName(fm.name);
  if (
    typeof fm.description !== "string" ||
    !fm.description.trim() ||
    [...fm.description].length > 1024
  ) {
    throw new ValidationError(
      "SKILL.md description must be a non-empty string of at most 1024 characters",
    );
  }
  for (const key of ["license", "allowed-tools", "compatibility"]) {
    if (fm[key] !== undefined && typeof fm[key] !== "string") {
      throw new ValidationError(`SKILL.md ${key} must be a string`);
    }
  }
  if (
    typeof fm.compatibility === "string" &&
    (!fm.compatibility.trim() || [...fm.compatibility].length > 500)
  ) {
    throw new ValidationError("SKILL.md compatibility must contain 1-500 characters");
  }
  if (
    fm.metadata !== undefined &&
    (!fm.metadata ||
      typeof fm.metadata !== "object" ||
      Array.isArray(fm.metadata) ||
      Object.values(fm.metadata).some((value) => typeof value !== "string"))
  ) {
    throw new ValidationError("SKILL.md metadata must map string keys to string values");
  }

  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fm)) {
    if (key !== "name" && key !== "description") metadata[key] = value;
  }

  return {
    frontmatter: {
      name: fm.name,
      description: fm.description,
      metadata,
    },
    body,
  };
}

type ParsedSkill = ReturnType<typeof parseFrontmatter>;

/**
 * The pre-validation parser: line-based `key: value`, everything except
 * name/description lands in metadata. Used only to keep already-installed skills
 * loading; anything newly written goes through parseFrontmatter.
 */
function parseLegacyFrontmatter(content: string): ParsedSkill {
  const match = content
    .replace(/^\uFEFF/, "")
    .match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!match) throw new ValidationError("Invalid SKILL.md: missing frontmatter");

  const fm: Record<string, string> = {};
  for (const line of (match[1] as string).split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  if (!fm.name) throw new ValidationError("SKILL.md name is required");
  if (!fm.description) throw new ValidationError("SKILL.md description is required");

  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fm)) {
    if (key !== "name" && key !== "description") metadata[key] = value;
  }
  return {
    frontmatter: { name: fm.name, description: fm.description, metadata },
    body: (match[2] ?? "").trim(),
  };
}

/** Strict first; if the file predates validation, fall back to the legacy parser with a warning. */
function parseInstalledFrontmatter(
  content: string,
): ParsedSkill & { warning?: string | undefined } {
  try {
    return parseFrontmatter(content);
  } catch (strictError) {
    try {
      return {
        ...parseLegacyFrontmatter(content),
        warning: `Loaded as a legacy skill: ${(strictError as Error).message}`,
      };
    } catch {
      throw strictError;
    }
  }
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
  return listSkillFiles(skillDir)
    .filter((file) => file.name.startsWith("references/"))
    .map((file) => ({ ...file, name: file.name.slice("references/".length) }));
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

function scanDirectory(
  dir: string,
  source: SkillSource,
  broken: SkillCache["broken"],
  warnings: SkillCache["warnings"],
): SkillMeta[] {
  const results: SkillMeta[] = [];
  if (!existsSync(dir) || lstatSync(dir).isSymbolicLink()) return results;

  try {
    for (const entry of readdirSync(dir)) {
      const skillDir = join(dir, entry);
      const skillFile = join(skillDir, "SKILL.md");
      try {
        if (!lstatSync(skillDir).isDirectory() || lstatSync(skillDir).isSymbolicLink()) continue;
        if (!existsSync(skillFile)) continue;
        if (lstatSync(skillFile).isSymbolicLink())
          throw new ValidationError("Skill entry point cannot be a symlink");
        const content = readFileSync(skillFile, "utf-8");
        // Built-ins ship with orc and must be valid; user and package skills may predate validation.
        const parsed: ReturnType<typeof parseInstalledFrontmatter> =
          source === "builtin" ? parseFrontmatter(content) : parseInstalledFrontmatter(content);
        const fm = parsed.frontmatter;
        const messages: string[] = [];
        if (parsed.warning) messages.push(parsed.warning);
        if (fm.name.normalize("NFKC") !== entry.normalize("NFKC")) {
          if (source === "builtin")
            throw new ValidationError("Skill directory name must match SKILL.md name");
          messages.push(`Skill directory "${entry}" does not match SKILL.md name "${fm.name}"`);
        }
        for (const message of messages) warnings.push({ path: skillFile, message });
        results.push({
          name: fm.name,
          description: fm.description,
          source,
          path: skillFile,
          metadata: fm.metadata,
        });
      } catch (error) {
        broken.push({ path: skillFile, error: (error as Error).message });
      }
    }
  } catch (error) {
    broken.push({ path: dir, error: (error as Error).message });
  }
  return results;
}

export function scanSkills(
  broken: SkillCache["broken"] = [],
  warnings: SkillCache["warnings"] = [],
): SkillMeta[] {
  const builtin = scanDirectory(BUILTIN_SKILLS_DIR, "builtin", broken, warnings);
  const user = scanDirectory(USER_SKILLS_DIR, "user", broken, warnings);
  const packagesDir = getPackagesDir();
  const packaged: SkillMeta[] = [];
  if (existsSync(packagesDir)) {
    packaged.push(
      ...scanDirectory(packagesDir, "user", broken, warnings).filter(
        (skill) =>
          !existsSync(join(dirname(skill.path), "plugin.json")) ||
          existsSync(join(dirname(skill.path), "apm.yml")),
      ),
    );
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const apmDir = join(packagesDir, entry.name, ".apm");
      if (existsSync(apmDir) && lstatSync(apmDir).isSymbolicLink()) continue;
      if (
        !existsSync(join(packagesDir, entry.name, "plugin.json")) ||
        existsSync(join(packagesDir, entry.name, "apm.yml"))
      ) {
        packaged.push(
          ...scanDirectory(
            join(packagesDir, entry.name, ".apm", "skills"),
            "user",
            broken,
            warnings,
          ),
        );
      }
      if (
        existsSync(join(packagesDir, entry.name, "plugin.json")) &&
        !existsSync(join(packagesDir, entry.name, "apm.yml"))
      ) {
        try {
          const manifest = readSkillFile(join(packagesDir, entry.name), "plugin.json", false);
          parsePluginManifest(manifest.content);
          const pluginSkills = scanDirectory(
            join(packagesDir, entry.name, "skills"),
            "builtin",
            broken,
            warnings,
          );
          packaged.push(
            ...pluginSkills.map((skill) => ({
              ...skill,
              source: "user" as const,
              name: `${entry.name}/${skill.name}`,
            })),
          );
        } catch (error) {
          broken.push({
            path: join(packagesDir, entry.name, "plugin.json"),
            error: (error as Error).message,
          });
        }
      }
    }
  }
  // Built-ins win (orc-worker-base is injected into every flow worker), then user, then packages.
  const skills = new Map<string, SkillMeta>();
  for (const skill of [...builtin, ...user, ...packaged]) {
    const existing = skills.get(skill.name);
    if (existing) {
      broken.push({
        path: skill.path,
        error: `Skill name ${skill.name} is already provided by ${existing.path}`,
      });
      continue;
    }
    skills.set(skill.name, skill);
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function loadCache(): SkillCache | null {
  try {
    const raw = readFileSync(CACHE_PATH, "utf-8");
    const cache = JSON.parse(raw) as SkillCache;
    return cache.version === 4 ? cache : null;
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
  const broken: SkillCache["broken"] = [];
  const warnings: SkillCache["warnings"] = [];
  const skills = scanSkills(broken, warnings);
  const cache: SkillCache = {
    version: 4,
    builtAt: new Date().toISOString(),
    skills,
    broken,
    warnings,
  };
  saveCache(cache);
  return cache;
}

function ensureCache(): SkillCache {
  const cached = loadCache();
  if (cached) return cached;
  return reloadCache();
}

export function skillValidationIssues(): SkillCache["broken"] {
  return ensureCache().broken ?? [];
}

export function skillWarnings(): SkillWarning[] {
  return ensureCache().warnings ?? [];
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
  if (opts?.q) {
    const q = opts.q.toLowerCase();
    skills = skills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }

  return skills;
}

export function readSkill(name: string, ref?: string): SkillFull | SkillRefContent | null {
  const cache = ensureCache();
  const meta = cache.skills.find((s) => s.name === name);
  if (!meta) return null;

  const skillDir = dirname(meta.path);

  if (ref) {
    return readSkillFile(skillDir, ref);
  }

  const content = readFileSync(meta.path, "utf-8");
  const { body } = parseInstalledFrontmatter(content);
  const references = listReferenceFiles(skillDir);

  return { ...meta, content: body, references, files: listSkillFiles(skillDir) };
}

export function createSkill(
  name: string,
  content: string,
  files: SkillFileInput[] = [],
): SkillFull {
  validateSkillName(name);

  const skillDir = join(USER_SKILLS_DIR, name);
  const skillFile = join(skillDir, "SKILL.md");

  if (existsSync(skillDir) || existsSync(join(BUILTIN_SKILLS_DIR, name))) {
    throw new Error(`Skill already exists: ${name}`);
  }

  const { frontmatter: fm, body } = parseFrontmatter(content);
  if (fm.name !== name) throw new ValidationError("Skill name must match SKILL.md frontmatter");
  const prepared = prepareSkillFiles(files, content);

  mkdirSync(USER_SKILLS_DIR, { recursive: true });
  mkdirSync(skillDir);
  writeFileSync(skillFile, content, { encoding: "utf-8", flag: "wx" });
  for (const file of prepared) {
    const path = join(skillDir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.bytes, { flag: "wx" });
  }

  reloadCache();

  const references = listReferenceFiles(skillDir);

  return {
    name: fm.name,
    description: fm.description,
    source: "user" as SkillSource,
    path: skillFile,
    metadata: fm.metadata,
    content: body,
    references,
    files: listSkillFiles(skillDir),
  };
}
