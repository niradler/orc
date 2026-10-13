import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import { z } from "zod";
import { ConflictError, ValidationError } from "./errors.js";
import {
  encodeSkillFile,
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  prepareSkillFiles,
  validateSkillPath,
} from "./skill-files.js";
import type {
  SkillDiscovery,
  SkillImportInput,
  SkillImportOrigin,
  SkillRepository,
} from "./skill-import-types.js";
import { createSkill, listSkills, parseFrontmatter, type SkillFull } from "./skill-service.js";

export type { SkillDiscovery, SkillImportInput, SkillImportOrigin } from "./skill-import-types.js";

const TreeEntrySchema = z.object({
  path: z.string(),
  type: z.string(),
  mode: z.string(),
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  size: z.number().optional(),
});
const TreeSchema = z.object({ tree: z.array(TreeEntrySchema).max(50000), truncated: z.boolean() });
type TreeEntry = z.infer<typeof TreeEntrySchema>;
export type SkillImportRecord = SkillImportOrigin & { files: Record<string, string> };

const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;

export function parseSkillRepository(source: string): SkillRepository {
  let repository = source.trim().replace(/\.git$/, "");
  let ref = "HEAD";
  let path = "";
  let skill: string | undefined;
  if (source.includes("://")) {
    let url: URL;
    try {
      url = new URL(source.trim());
    } catch {
      throw new ValidationError("Enter a GitHub repository URL, owner/repo or skills.sh skill URL");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      throw new ValidationError("Use an HTTPS source URL without credentials, query or fragment");
    let parts: string[];
    try {
      parts = url.pathname.replace(/\/$/, "").slice(1).split("/").map(decodeURIComponent);
    } catch {
      throw new ValidationError("Source URL contains invalid encoding");
    }
    repository = parts
      .slice(0, 2)
      .join("/")
      .replace(/\.git$/, "");
    if (url.hostname === "skills.sh") {
      if (parts.length !== 3) throw new ValidationError("Use a skills.sh owner/repo/skill link");
      skill = parts[2];
    } else if (url.hostname === "github.com") {
      if (parts.length > 2) {
        if (!["tree", "blob"].includes(parts[2] ?? "") || !parts[3])
          throw new ValidationError("Use a GitHub repository or tree/branch/skill-folder URL");
        ref = parts[3] as string;
        path = parts.slice(4).join("/");
        if (parts[2] === "blob") {
          if (!path.endsWith("SKILL.md"))
            throw new ValidationError("Blob URL must point to SKILL.md");
          path = posix.dirname(path);
          if (path === ".") path = "";
        }
      }
    } else throw new ValidationError("Only github.com and skills.sh sources are supported");
  }
  if (
    !repositoryPattern.test(repository) ||
    repository.split("/").some((part) => part === "." || part === "..")
  )
    throw new ValidationError("Invalid GitHub repository; use owner/repo");
  if (path) validateSkillPath(path);
  if (
    !ref ||
    ref.length > 200 ||
    Array.from(ref).some((character) => character.charCodeAt(0) <= 32)
  )
    throw new ValidationError("Invalid GitHub ref");
  return { repository, ref, path, ...(skill ? { skill } : {}) };
}

async function readRemote(url: string, maximum: number): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "orc-skill-import" },
    });
  } catch {
    throw new ValidationError("GitHub request failed or timed out; try again");
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404)
      throw new ValidationError(
        "GitHub repository, ref or file not found; public repositories are supported",
      );
    if (response.status === 403 || response.status === 429)
      throw new ValidationError("GitHub rate limit reached; try again later");
    throw new ValidationError(`GitHub request failed (${response.status})`);
  }
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel();
    throw new ValidationError("GitHub response exceeds the import size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ValidationError("Empty GitHub response");
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum)
        throw new ValidationError("GitHub response exceeds the import size limit");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

function githubUrl(repository: string, route: string): string {
  return `https://api.github.com/repos/${repository}/${route}`;
}

async function resolveCommit(repository: string, ref: string): Promise<string> {
  const bytes = await readRemote(
    githubUrl(repository, `commits/${encodeURIComponent(ref)}`),
    2 * 1024 * 1024,
  );
  return z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }).parse(JSON.parse(bytes.toString()))
    .sha;
}

async function readTree(repository: string, commit: string): Promise<TreeEntry[]> {
  const bytes = await readRemote(
    githubUrl(repository, `git/trees/${commit}?recursive=1`),
    12 * 1024 * 1024,
  );
  const parsed = TreeSchema.parse(JSON.parse(bytes.toString()));
  if (parsed.truncated) throw new ValidationError("Repository tree is too large to import safely");
  return parsed.tree;
}

async function readRepositoryFile(
  repository: string,
  commit: string,
  path: string,
): Promise<Buffer> {
  validateSkillPath(path);
  return readRemote(
    `https://raw.githubusercontent.com/${repository}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`,
    MAX_SKILL_FILE_BYTES,
  );
}

function entryPaths(tree: TreeEntry[], source: SkillRepository): string[] {
  return tree
    .filter(
      (entry) =>
        (entry.type === "blob" && entry.mode === "100644") ||
        (entry.type === "blob" && entry.mode === "100755"),
    )
    .filter((entry) => entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md"))
    .filter(
      (entry) =>
        !source.path ||
        entry.path === `${source.path}/SKILL.md` ||
        entry.path.startsWith(`${source.path}/`),
    )
    .map((entry) => entry.path);
}

export async function discoverRepositorySkills(source: string): Promise<SkillDiscovery> {
  const origin = parseSkillRepository(source);
  const commit = await resolveCommit(origin.repository, origin.ref);
  const tree = await readTree(origin.repository, commit);
  const paths = entryPaths(tree, origin);
  if (paths.length > 128)
    throw new ValidationError("More than 128 skills found; use a GitHub subfolder link");
  const installed = new Set(listSkills({ reload: true }).map((entry) => entry.name));
  const skills: SkillDiscovery["skills"] = [];
  const issues: SkillDiscovery["issues"] = [];
  for (const entry of paths) {
    try {
      const bytes = await readRepositoryFile(origin.repository, commit, entry);
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const { frontmatter } = parseFrontmatter(content);
      if (origin.skill && frontmatter.name !== origin.skill) continue;
      skills.push({
        name: frontmatter.name,
        description: frontmatter.description,
        path: posix.dirname(entry) === "." ? "" : posix.dirname(entry),
        installed: installed.has(frontmatter.name),
      });
    } catch (error) {
      issues.push({
        path: entry,
        error: error instanceof ValidationError ? error.message : "Invalid SKILL.md",
      });
    }
  }
  return { ...origin, commit, skills, issues };
}

export async function downloadRepositorySkill(
  repository: string,
  commit: string,
  path: string,
  tree: TreeEntry[],
): Promise<{ name: string; content: string; files: Record<string, string> }> {
  const prefix = path ? `${path}/` : "";
  const entries = tree.filter((entry) => entry.path.startsWith(prefix) && entry.type !== "tree");
  if (!entries.some((entry) => entry.path === `${prefix}SKILL.md`))
    throw new ValidationError("Selected folder does not contain SKILL.md");
  if (entries.length > MAX_SKILL_FILES + 1) throw new ValidationError("Too many skill files");
  let total = 0;
  const files: Record<string, string> = Object.create(null);
  for (const entry of entries) {
    const relative = entry.path.slice(prefix.length);
    validateSkillPath(relative);
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
      throw new ValidationError(`Symlinks and submodules cannot be imported: ${relative}`);
    if ((entry.size ?? 0) > MAX_SKILL_FILE_BYTES)
      throw new ValidationError(`Skill file exceeds 8 MiB: ${relative}`);
    const bytes = await readRepositoryFile(repository, commit, entry.path);
    total += bytes.length;
    if (total > MAX_SKILL_BUNDLE_BYTES) throw new ValidationError("Skill bundle exceeds 16 MiB");
    files[relative] = bytes.toString("base64");
  }
  const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    Buffer.from(files["SKILL.md"] as string, "base64"),
  );
  const { frontmatter } = parseFrontmatter(content);
  prepareSkillFiles(
    Object.entries(files)
      .filter(([name]) => name !== "SKILL.md")
      .map(([path, content]) => ({ path, content, encoding: "base64" })),
    content,
  );
  return { name: frontmatter.name, content, files };
}

export function getSkillImportRecord(name: string): SkillImportRecord | null {
  validateSkillPath(name);
  if (name.includes("/")) throw new ValidationError("Invalid skill name");
  const path = join(homedir(), ".orc", "skill-imports", `${name}.json`);
  if (existsSync(dirname(path)) && lstatSync(dirname(path)).isSymbolicLink())
    throw new ValidationError("Import record directory cannot be a symlink");
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink() || lstatSync(path).size > 24 * 1024 * 1024)
    throw new ValidationError("Invalid skill import record");
  const record = z
    .object({
      repository: z.string().regex(repositoryPattern),
      ref: z.string().min(1).max(200),
      path: z.string(),
      skill: z.string().optional(),
      commit: z.string().regex(/^[a-f0-9]{40}$/),
      importedAt: z.string(),
      files: z.record(z.string(), z.string()),
    })
    .parse(JSON.parse(readFileSync(path, "utf8")));
  if (record.path) validateSkillPath(record.path);
  return record;
}

export function saveSkillImportRecord(name: string, record: SkillImportRecord): void {
  validateSkillPath(name);
  if (name.includes("/")) throw new ValidationError("Invalid skill name");
  const directory = join(homedir(), ".orc", "skill-imports");
  mkdirSync(directory, { recursive: true });
  if (lstatSync(directory).isSymbolicLink())
    throw new ValidationError("Import record directory cannot be a symlink");
  const temporary = join(directory, `${name}-${crypto.randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
  renameSync(temporary, join(directory, `${name}.json`));
}

export function getSkillImportOrigin(name: string): SkillImportOrigin | null {
  const record = getSkillImportRecord(name);
  if (!record) return null;
  const { files: _files, ...origin } = record;
  return origin;
}

export async function importRepositorySkills(input: SkillImportInput): Promise<SkillFull[]> {
  const origin = parseSkillRepository(input.source);
  if (!/^[a-f0-9]{40}$/.test(input.commit)) throw new ValidationError("Invalid commit");
  if (
    !input.paths.length ||
    input.paths.length > 16 ||
    new Set(input.paths).size !== input.paths.length
  )
    throw new ValidationError("Select 1-16 unique skill folders");
  const tree = await readTree(origin.repository, input.commit);
  const allowed = new Set(
    entryPaths(tree, origin).map((entry) =>
      posix.dirname(entry) === "." ? "" : posix.dirname(entry),
    ),
  );
  const bundles = [];
  let total = 0;
  const names = new Set(listSkills({ reload: true }).map((entry) => entry.name));
  for (const path of input.paths) {
    if (path) validateSkillPath(path);
    if (!allowed.has(path))
      throw new ValidationError("Selected skill is outside the source folder");
    const bundle = await downloadRepositorySkill(origin.repository, input.commit, path, tree);
    total += Object.values(bundle.files).reduce(
      (size, content) => size + Buffer.byteLength(content, "base64"),
      0,
    );
    if (total > 64 * 1024 * 1024)
      throw new ValidationError("Selected skills exceed 64 MiB; import fewer skills at once");
    if (origin.skill && bundle.name !== origin.skill)
      throw new ValidationError("Selected skill does not match skills.sh link");
    if (names.has(bundle.name)) throw new ConflictError(`Skill already exists: ${bundle.name}`);
    names.add(bundle.name);
    bundles.push({ ...bundle, path });
  }
  const installedNow = new Set(listSkills({ reload: true }).map((skill) => skill.name));
  for (const bundle of bundles) {
    if (installedNow.has(bundle.name))
      throw new ConflictError(`Skill already exists: ${bundle.name}`);
  }
  return bundles.map((bundle) => {
    const skill = createSkill(
      bundle.name,
      bundle.content,
      Object.entries(bundle.files)
        .filter(([name]) => name !== "SKILL.md")
        .map(([path, content]) => ({ path, ...encodeSkillFile(Buffer.from(content, "base64")) })),
    );
    saveSkillImportRecord(bundle.name, {
      ...origin,
      path: bundle.path,
      commit: input.commit,
      importedAt: new Date().toISOString(),
      files: bundle.files,
    });
    return skill;
  });
}

export async function fetchSkillUpdate(
  origin: SkillImportOrigin,
): Promise<{ commit: string; name: string; content: string; files: Record<string, string> }> {
  const commit = await resolveCommit(origin.repository, origin.ref);
  const tree = await readTree(origin.repository, commit);
  return {
    commit,
    ...(await downloadRepositorySkill(origin.repository, commit, origin.path, tree)),
  };
}
