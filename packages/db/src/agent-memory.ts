import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ValidationError } from "@orc/core/errors";
import { parseMarkdownFrontmatter } from "@orc/core/markdown-frontmatter";
import type { RuleEvent } from "@orc/core/rule-types";
import { withinWorkspace } from "@orc/core/rules";
import { MemoryStore } from "./memories.js";

export function claudeMemoryDirectory(cwd: string, configured = "auto"): string {
  const expand = (value: string): string =>
    value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : resolve(value);
  if (configured !== "auto") return expand(configured);
  const configDirectory = resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"));
  const git = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    timeout: 500,
    windowsHide: true,
  });
  const common = git.status === 0 ? git.stdout.trim() : "";
  const root = common && basename(common) === ".git" ? dirname(common) : cwd;
  let custom: string | undefined;
  for (const file of [
    join(configDirectory, "settings.json"),
    join(root, ".claude/settings.json"),
    join(root, ".claude/settings.local.json"),
  ]) {
    if (!existsSync(file) || statSync(file).size > 65536) continue;
    const setting = JSON.parse(readFileSync(file, "utf8")) as { autoMemoryDirectory?: unknown };
    if (typeof setting.autoMemoryDirectory === "string") custom = setting.autoMemoryDirectory;
  }
  if (custom) {
    if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/|~\/)/.test(custom))
      throw new Error("Claude memory directory must be absolute");
    return expand(custom);
  }
  const project = process.env.CLAUDE_CODE_PROJECT_DIR_NAME ?? root.replace(/[^a-zA-Z0-9]/g, "-");
  if (!/^[a-zA-Z0-9_-]+$/.test(project)) throw new Error("Invalid Claude project directory name");
  return join(configDirectory, "projects", project, "memory");
}

export type MemorySyncResult = {
  /** Memories created or changed. */
  updated: number;
  /** Files that could not become a memory, with the reason. */
  skipped: { file: string; reason: string }[];
};

/** Claude names memories freely (`feedback_testing`); ORC names follow the skill name rules. */
function memoryName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

/** Upserts Claude auto-memory files (frontmatter name + description, body) into project memories. */
export function syncClaudeMemory(
  db: Database,
  event: RuleEvent,
  projectId: string | null,
  directory: string,
): MemorySyncResult {
  if (event.backend !== "claude")
    throw new Error("Claude memory synchronization requires local Claude");
  const result: MemorySyncResult = { updated: 0, skipped: [] };
  if (!existsSync(directory)) return result;
  const root = realpathSync(directory);
  if (!statSync(root).isDirectory()) throw new Error("Memory source must be a directory");
  let files: string[] = [];
  if (event.phase === "post_tool") {
    if (event.failed) return result;
    const path = event.input.file_path ?? event.input.path;
    if (typeof path !== "string") return result;
    files = [resolve(event.cwd, path)];
  } else {
    let visited = 0;
    const walk = (path: string, depth = 0): void => {
      if (++visited > 512 || depth > 16)
        throw new Error("Memory directory traversal exceeds limit");
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(join(path, entry.name), depth + 1);
        else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(join(path, entry.name));
        if (files.length > 256) throw new Error("Memory source file count exceeds limit");
      }
    };
    walk(root);
  }
  const memories = new MemoryStore(db);
  let bytes = 0;
  for (const file of files) {
    if (
      !withinWorkspace(root, file) ||
      !existsSync(file) ||
      basename(file).toLowerCase() === "memory.md" ||
      !/\.md$/i.test(file)
    )
      continue;
    const actual = realpathSync(file);
    if (!withinWorkspace(root, actual)) throw new Error("Memory file escapes configured directory");
    const stat = statSync(actual);
    if (!stat.isFile() || stat.size > 65536)
      throw new Error("Memory file must be a bounded regular Markdown file");
    bytes += stat.size;
    if (bytes > 1048576) throw new Error("Memory synchronization exceeds byte budget");
    if (projectId === null)
      throw new Error("Claude memory synchronization requires a project; memories are per project");
    try {
      const { fields, body } = parseMarkdownFrontmatter(readFileSync(actual, "utf8"));
      const name = memoryName(
        typeof fields.name === "string" ? fields.name : basename(actual, ".md"),
      );
      if (typeof fields.description !== "string")
        throw new ValidationError("Frontmatter description is required");
      const memory = { description: fields.description.trim(), content: body };
      const writer = { author: "claude-memory-sync", session_id: event.session_id };
      const existing = db
        .query<{ description: string; content: string }, [string, string]>(
          "SELECT description,content FROM memories WHERE project_id=? AND name=?",
        )
        .get(projectId, name);
      if (existing?.description === memory.description && existing.content === memory.content)
        continue;
      if (existing) memories.update(projectId, name, memory, writer);
      else memories.create({ ...memory, ...writer, project_id: projectId, name });
      result.updated++;
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      result.skipped.push({ file: actual, reason: error.message });
    }
  }
  return result;
}
