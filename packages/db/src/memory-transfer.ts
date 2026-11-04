import type { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { ConflictError, NotFoundError, ValidationError } from "@orc/core/errors";
import { parseMarkdownFrontmatter } from "@orc/core/markdown-frontmatter";
import {
  closestMatch,
  compareProfiles,
  type SimilarityLevel,
  type TextProfile,
  textProfile,
} from "@orc/core/similarity";
import { claudeConfigDirectory, isMemoryFile, memoryName, nameOf } from "./agent-memory.js";
import { MemoryStore, type MemoryWriter } from "./memories.js";

const MAX_FILES = 256;
const MAX_FILE_BYTES = 65536;
const INDEX_FILE = "MEMORY.md";
const BACKUP_DIR = join(homedir(), ".orc", "memory-export-backups");
const IMPORT_AUTHOR = "native-memory-import";

/** A Claude Code project's auto-memory folder (~/.claude/projects/<project>/memory). */
export type NativeMemorySource = {
  agent: "claude";
  /** Claude's project folder name: the project path with every other character replaced by "-". */
  label: string;
  dir: string;
  count: number;
  /** Whether the folder name ends with the ORC project's name. */
  project_match: boolean;
};
export type MemoryMatch = {
  name: string;
  level: Exclude<SimilarityLevel, "different">;
  score: number;
  /** orc: an ORC memory · folder: another file in the folder. */
  where: "orc" | "folder";
};
/**
 * new: not in ORC · installed: ORC has the same memory · duplicate: ORC has it apart from a tiny
 * edit, under this or another name · conflict: ORC has this name with other content · invalid:
 * cannot be imported (no description, too long, or two files map to one name).
 */
export type NativeMemoryStatus = "new" | "installed" | "duplicate" | "conflict" | "invalid";
export type NativeMemory = {
  file: string;
  name: string;
  description: string;
  status: NativeMemoryStatus;
  /** Whether `replace` may update the ORC memory of the same name (its history keeps the old one). */
  can_replace: boolean;
  match?: MemoryMatch | undefined;
  error?: string | undefined;
};
export type MemoryImportPreview = { dir: string; memories: NativeMemory[] };
export type MemoryImportItem = { name: string; replace?: boolean | undefined };
export type MemoryImportResult = {
  imported: string[];
  replaced: string[];
  skipped: Array<{ name: string; reason: string }>;
};
/**
 * new: not in the folder · identical: the folder has the same memory · near: the folder has it
 * apart from a tiny edit · conflict: the folder has this name with other content · duplicate: the
 * folder has the same memory under another name.
 */
export type MemoryExportStatus = "new" | "identical" | "near" | "conflict" | "duplicate";
export type MemoryExportItem = {
  name: string;
  description: string;
  /** File written: the existing file holding this memory, otherwise <dir>/<name>.md. */
  file: string;
  status: MemoryExportStatus;
  /** Whether `overwrite` may write it (replacing the file, or adding it beside a near copy). */
  can_overwrite: boolean;
  match?: MemoryMatch | undefined;
  reason?: string | undefined;
};
/** `index`: new files are also listed in the folder's MEMORY.md, as Claude Code expects. */
export type MemoryExportPlan = { dir: string; index: boolean; memories: MemoryExportItem[] };
export type MemoryExportResult = {
  dir: string;
  exported: Array<{ name: string; file: string; replaced: boolean; backup?: string | undefined }>;
  skipped: Array<{ name: string; reason: string }>;
  index_updated: boolean;
};

type NativeFile = {
  file: string;
  name: string;
  description: string;
  content: string;
  fields: Record<string, unknown>;
  profile?: TextProfile;
  error?: string;
};
type OrcMemory = { name: string; description: string; content: string; profile: TextProfile };

function samePath(left: string, right: string): boolean {
  const normalize = (path: string) =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  return normalize(left) === normalize(right);
}

function memoryProfile(description: string, content: string): TextProfile {
  return textProfile(`${description}\n\n${content}`);
}

function absoluteDir(dir: string): string {
  if (!isAbsolute(dir)) throw new ValidationError("Memory folder must be an absolute path");
  const resolved = resolve(dir);
  if (existsSync(resolved) && !statSync(resolved).isDirectory())
    throw new ValidationError(`Not a folder: ${resolved}`);
  return resolved;
}

/** Claude Code project memory folders, those matching the project name first. */
export function listNativeMemorySources(projectName?: string): NativeMemorySource[] {
  const projects = join(claudeConfigDirectory(), "projects");
  if (!existsSync(projects)) return [];
  const wanted = projectName?.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const sources: NativeMemorySource[] = [];
  for (const entry of readdirSync(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(projects, entry.name, "memory");
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    const label = entry.name;
    const lower = label.toLowerCase();
    sources.push({
      agent: "claude",
      label,
      dir,
      count: memoryFiles(dir, false).length,
      project_match: Boolean(wanted && (lower === wanted || lower.endsWith(`-${wanted}`))),
    });
  }
  return sources.sort(
    (left, right) =>
      Number(right.project_match) - Number(left.project_match) ||
      right.count - left.count ||
      left.label.localeCompare(right.label),
  );
}

function memoryFiles(dir: string, limit = true): string[] {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isMemoryFile(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort();
  if (limit && files.length > MAX_FILES)
    throw new ValidationError(`Folder has more than ${MAX_FILES} memory files`);
  return files;
}

/** Memory files (*.md except MEMORY.md, symlinks skipped) parsed like Claude's own memory sync. */
function readNativeFiles(dir: string): NativeFile[] {
  if (!existsSync(dir)) return [];
  return memoryFiles(dir).map((file): NativeFile => {
    try {
      if (statSync(file).size > MAX_FILE_BYTES) throw new ValidationError("File exceeds 64 KiB");
      const { fields, body } = parseMarkdownFrontmatter(readFileSync(file, "utf8"));
      const name = nameOf(file, fields);
      if (!name) throw new ValidationError("No usable memory name");
      if (typeof fields.description !== "string" || !fields.description.trim())
        throw new ValidationError("Frontmatter description is required");
      const description = fields.description.trim();
      return {
        file,
        name,
        description,
        content: body,
        fields,
        profile: memoryProfile(description, body),
      };
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return {
        file,
        name: memoryName(basename(file, ".md")),
        description: "",
        content: "",
        fields: {},
        error: error.message,
      };
    }
  });
}

function orcMemories(db: Database, projectId: string): Map<string, OrcMemory> {
  if (!db.query("SELECT 1 FROM projects WHERE id=?").get(projectId))
    throw new NotFoundError("Project", projectId);
  const rows = db
    .query<{ name: string; description: string; content: string }, [string]>(
      "SELECT name,description,content FROM memories WHERE project_id=? ORDER BY name",
    )
    .all(projectId);
  return new Map(
    rows.map((row) => [row.name, { ...row, profile: memoryProfile(row.description, row.content) }]),
  );
}

function toMatch(
  name: string,
  level: SimilarityLevel,
  score: number,
  where: MemoryMatch["where"],
): MemoryMatch | undefined {
  return level === "different" ? undefined : { name, level, score, where };
}

function candidates<T extends { name: string; profile?: TextProfile | undefined }>(items: T[]) {
  return items.flatMap((item) => (item.profile ? [{ key: item.name, profile: item.profile }] : []));
}

function classifyImport(
  files: NativeFile[],
  orc: Map<string, OrcMemory>,
  store: MemoryStore,
): NativeMemory[] {
  const owners = new Map<string, string[]>();
  for (const file of files) owners.set(file.name, [...(owners.get(file.name) ?? []), file.file]);
  const earlier: NativeFile[] = [];
  return files.map((file): NativeMemory => {
    const base = { file: file.file, name: file.name, description: file.description };
    const invalid = (error: string): NativeMemory => ({
      ...base,
      status: "invalid",
      can_replace: false,
      error,
    });
    if (file.error || !file.profile) return invalid(file.error ?? "Unreadable");
    const claimed = owners.get(file.name) ?? [];
    if (claimed.length > 1)
      return invalid(
        `${claimed.map((path) => basename(path)).join(", ")} map to the same memory name ${file.name}; keep one file per name`,
      );
    const problem = store.problem(file.description, file.content);
    if (problem) return invalid(problem);
    const same = orc.get(file.name);
    if (same) {
      if (same.description === file.description && same.content === file.content)
        return { ...base, status: "installed", can_replace: false };
      const result = compareProfiles(file.profile, same.profile);
      const match = toMatch(same.name, result.level, result.score, "orc");
      if (result.level === "identical")
        return { ...base, status: "installed", can_replace: true, match };
      return {
        ...base,
        status: result.level === "near" ? "duplicate" : "conflict",
        can_replace: true,
        ...(match ? { match } : {}),
      };
    }
    const closest = closestMatch(file.profile, candidates([...orc.values()]));
    if (closest && closest.level !== "similar")
      return {
        ...base,
        status: "duplicate",
        can_replace: false,
        match: toMatch(closest.key, closest.level, closest.score, "orc"),
      };
    const sibling = closestMatch(file.profile, candidates(earlier));
    earlier.push(file);
    const warning = closest
      ? toMatch(closest.key, closest.level, closest.score, "orc")
      : sibling
        ? toMatch(sibling.key, sibling.level, sibling.score, "folder")
        : undefined;
    return { ...base, status: "new", can_replace: false, ...(warning ? { match: warning } : {}) };
  });
}

/** What importing a native memory folder into a project would do, per file, without writing. */
export function previewMemoryImport(
  db: Database,
  projectId: string,
  dir: string,
  store: MemoryStore = new MemoryStore(db),
): MemoryImportPreview {
  const folder = absoluteDir(dir);
  if (!existsSync(folder)) throw new ValidationError(`Folder not found: ${folder}`);
  return {
    dir: folder,
    memories: classifyImport(readNativeFiles(folder), orcMemories(db, projectId), store),
  };
}

/**
 * Imports selected native memory files into a project. New memories are created; `replace`
 * updates a same-name ORC memory that differs (its history keeps the previous content). A memory
 * that is the same as, or a near copy of, one already in ORC or imported earlier in this batch
 * is skipped.
 */
export function importNativeMemories(
  db: Database,
  projectId: string,
  dir: string,
  items: MemoryImportItem[],
  writer: MemoryWriter = {},
  store: MemoryStore = new MemoryStore(db),
): MemoryImportResult {
  if (!items.length || items.length > MAX_FILES)
    throw new ValidationError(`Select 1-${MAX_FILES} memories`);
  const folder = absoluteDir(dir);
  if (!existsSync(folder)) throw new ValidationError(`Folder not found: ${folder}`);
  const files = readNativeFiles(folder);
  const preview = new Map(
    classifyImport(files, orcMemories(db, projectId), store).map((memory) => [memory.name, memory]),
  );
  const byName = new Map(files.map((file) => [file.name, file]));
  const result: MemoryImportResult = { imported: [], replaced: [], skipped: [] };
  const batch: NativeFile[] = [];
  const author = { author: writer.author ?? IMPORT_AUTHOR, session_id: writer.session_id ?? null };
  for (const item of items) {
    const memory = preview.get(item.name);
    const file = byName.get(item.name);
    if (!memory || !file?.profile) {
      result.skipped.push({ name: item.name, reason: "Not found in the folder" });
      continue;
    }
    const twin = closestMatch(file.profile, candidates(batch));
    if (twin && twin.level !== "similar") {
      result.skipped.push({
        name: item.name,
        reason: `Same as ${twin.key}, imported in this batch`,
      });
      continue;
    }
    try {
      if (memory.status === "new") {
        store.create({
          ...author,
          project_id: projectId,
          name: memory.name,
          description: file.description,
          content: file.content,
        });
        result.imported.push(memory.name);
      } else if (item.replace && memory.can_replace) {
        store.update(
          projectId,
          memory.name,
          { description: file.description, content: file.content },
          { ...author, reason: `Imported from ${file.file}` },
        );
        result.replaced.push(memory.name);
      } else {
        result.skipped.push({ name: item.name, reason: importSkipReason(memory) });
        continue;
      }
      batch.push(file);
    } catch (error) {
      if (!(error instanceof ValidationError || error instanceof ConflictError)) throw error;
      result.skipped.push({ name: item.name, reason: error.message });
    }
  }
  return result;
}

function importSkipReason(memory: NativeMemory): string {
  if (memory.status === "invalid") return memory.error ?? "Invalid";
  if (memory.status === "installed") return "Already in ORC";
  if (memory.status === "duplicate" && memory.match && memory.match.name !== memory.name)
    return `Near copy of ${memory.match.name} in ORC`;
  return `${memory.status === "duplicate" ? "A near copy" : "A different memory"} with this name is in ORC; select replace to update it`;
}

function isClaudeMemoryDir(dir: string): boolean {
  return (
    basename(dir) === "memory" &&
    samePath(dirname(dirname(dir)), join(claudeConfigDirectory(), "projects"))
  );
}

type PlannedExport = MemoryExportItem & { memory: OrcMemory; existing?: NativeFile | undefined };

function buildExportPlan(
  db: Database,
  projectId: string,
  dir: string,
  names: string[] | undefined,
): { dir: string; index: boolean; items: PlannedExport[] } {
  const folder = absoluteDir(dir);
  const orc = orcMemories(db, projectId);
  const selected = names?.length ? [...new Set(names)] : [...orc.keys()];
  for (const name of selected) if (!orc.has(name)) throw new NotFoundError("Memory", name);
  const files = readNativeFiles(folder);
  const byName = new Map<string, NativeFile>();
  for (const file of files) if (!byName.has(file.name)) byName.set(file.name, file);
  const items = selected.map((name): PlannedExport => {
    const memory = orc.get(name) as OrcMemory;
    const base = { name, description: memory.description, memory };
    const existing = byName.get(name);
    if (existing) {
      const result = existing.profile
        ? compareProfiles(memory.profile, existing.profile)
        : { level: "different" as const, score: 0 };
      const match = toMatch(name, result.level, result.score, "folder");
      return {
        ...base,
        file: existing.file,
        existing,
        status:
          result.level === "identical"
            ? "identical"
            : result.level === "near"
              ? "near"
              : "conflict",
        can_overwrite: result.level !== "identical",
        ...(match ? { match } : {}),
        ...(existing.error ? { reason: existing.error } : {}),
      };
    }
    const file = join(folder, `${name}.md`);
    if (existsSync(file))
      return {
        ...base,
        file,
        status: "conflict",
        can_overwrite: false,
        reason: `${basename(file)} exists and holds another memory`,
      };
    const closest = closestMatch(memory.profile, candidates(files));
    const match = closest
      ? toMatch(closest.key, closest.level, closest.score, "folder")
      : undefined;
    if (closest && closest.level !== "similar")
      return {
        ...base,
        file,
        status: "duplicate",
        can_overwrite: true,
        match,
        reason: `${closest.key} in the folder is the same memory`,
      };
    return { ...base, file, status: "new", can_overwrite: false, ...(match ? { match } : {}) };
  });
  return {
    dir: folder,
    index: existsSync(join(folder, INDEX_FILE)) || isClaudeMemoryDir(folder),
    items,
  };
}

/** What exporting project memories to a native folder would do, per memory, without writing. */
export function planMemoryExport(
  db: Database,
  projectId: string,
  dir: string,
  names?: string[],
): MemoryExportPlan {
  const plan = buildExportPlan(db, projectId, dir, names);
  return {
    dir: plan.dir,
    index: plan.index,
    memories: plan.items.map(({ memory: _memory, existing: _existing, ...item }) => item),
  };
}

/** Claude's memory file: name and description frontmatter (other existing fields kept), then the body. */
export function nativeMemoryText(
  name: string,
  description: string,
  content: string,
  fields: Record<string, unknown> = {},
): string {
  const { name: existingName, description: _description, ...rest } = fields;
  const keptName =
    typeof existingName === "string" && memoryName(existingName) === name ? existingName : name;
  const frontmatter = Bun.YAML.stringify({ name: keptName, description, ...rest }, null, 2);
  return `---\n${frontmatter.trimEnd()}\n---\n\n${content.trim()}\n`;
}

function writeAtomic(file: string, text: string, create: boolean): void {
  if (create) {
    writeFileSync(file, text, { flag: "wx" });
    return;
  }
  const temporary = join(dirname(file), `.${basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { flag: "wx" });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function indexLine(name: string, file: string, description: string): string {
  const hook = description.replace(/\s+/g, " ").trim();
  return `- [${name}](${basename(file)}) — ${hook.length > 150 ? `${hook.slice(0, 147)}...` : hook}`;
}

function appendIndex(
  dir: string,
  entries: Array<{ name: string; file: string; description: string }>,
): boolean {
  const index = join(dir, INDEX_FILE);
  const current = existsSync(index) ? readFileSync(index, "utf8") : "";
  const missing = entries.filter((entry) => !current.includes(`](${basename(entry.file)})`));
  if (!missing.length) return false;
  const prefix = !current ? "# Memory Index\n\n" : current.endsWith("\n") ? "" : "\n";
  writeAtomic(
    index,
    `${current}${prefix}${missing.map((entry) => indexLine(entry.name, entry.file, entry.description)).join("\n")}\n`,
    !current && !existsSync(index),
  );
  return true;
}

/**
 * Writes project memories as native memory files. New memories are written as <name>.md; identical
 * ones are left alone; near copies, conflicts and same-content files under another name are
 * written only when listed in `overwrite`, and a replaced file is first copied to
 * ~/.orc/memory-export-backups. New files are added to MEMORY.md for Claude memory folders.
 */
export function exportNativeMemories(
  db: Database,
  projectId: string,
  dir: string,
  input: { names?: string[] | undefined; overwrite?: string[] | undefined } = {},
): MemoryExportResult {
  const plan = buildExportPlan(db, projectId, dir, input.names);
  const overwrite = new Set(input.overwrite ?? []);
  const result: MemoryExportResult = {
    dir: plan.dir,
    exported: [],
    skipped: [],
    index_updated: false,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const indexed: Array<{ name: string; file: string; description: string }> = [];
  for (const item of plan.items) {
    const allowed = item.status === "new" || (item.can_overwrite && overwrite.has(item.name));
    if (!allowed) {
      result.skipped.push({ name: item.name, reason: exportSkipReason(item) });
      continue;
    }
    try {
      mkdirSync(plan.dir, { recursive: true });
      const replacing = Boolean(item.existing) && existsSync(item.file);
      let backup: string | undefined;
      if (replacing) {
        backup = join(BACKUP_DIR, stamp, basename(item.file));
        mkdirSync(dirname(backup), { recursive: true });
        copyFileSync(item.file, backup);
      }
      const text = nativeMemoryText(
        item.name,
        item.memory.description,
        item.memory.content,
        item.existing?.error ? {} : item.existing?.fields,
      );
      writeAtomic(item.file, text, !replacing);
      result.exported.push({
        name: item.name,
        file: item.file,
        replaced: replacing,
        ...(backup ? { backup } : {}),
      });
      indexed.push({ name: item.name, file: item.file, description: item.memory.description });
    } catch (error) {
      result.skipped.push({ name: item.name, reason: (error as Error).message });
    }
  }
  if (plan.index && indexed.length) result.index_updated = appendIndex(plan.dir, indexed);
  return result;
}

function exportSkipReason(item: MemoryExportItem): string {
  if (item.status === "identical") return "Already identical in the folder";
  if (!item.can_overwrite) return item.reason ?? "Cannot be written";
  if (item.status === "duplicate") return `${item.reason}; select overwrite to write it anyway`;
  return `${item.status === "near" ? "A near copy" : "A different memory"} with this name is in the folder; select overwrite to replace it`;
}
