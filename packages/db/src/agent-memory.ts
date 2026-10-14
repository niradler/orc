import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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

export function syncClaudeMemory(
  db: Database,
  event: RuleEvent,
  projectId: string | null,
  directory: string,
): number {
  if (event.backend !== "claude")
    throw new Error("Claude memory synchronization requires local Claude");
  if (!existsSync(directory)) return 0;
  const root = realpathSync(directory);
  if (!statSync(root).isDirectory()) throw new Error("Memory source must be a directory");
  let files: string[] = [];
  if (event.phase === "post_tool") {
    if (event.failed) return 0;
    const path = event.input.file_path ?? event.input.path;
    if (typeof path !== "string") return 0;
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
  db.exec(
    "CREATE TABLE IF NOT EXISTS agent_memory_sources(source_key TEXT PRIMARY KEY,source_path TEXT NOT NULL,project_id TEXT,memory_id TEXT NOT NULL,content_hash TEXT NOT NULL,updated_at INTEGER NOT NULL)",
  );
  const memories = new MemoryStore(db);
  let updated = 0;
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
    const content = readFileSync(actual, "utf8").trim();
    if (!content) continue;
    const hash = createHash("sha256").update(content).digest("hex");
    const key = createHash("sha256")
      .update(JSON.stringify([projectId, actual]))
      .digest("hex");
    db.transaction(() => {
      const prior = db
        .query<{ memory_id: string; content_hash: string }, [string]>(
          "SELECT memory_id,content_hash FROM agent_memory_sources WHERE source_key=?",
        )
        .get(key);
      const existing = prior
        ? db
            .query("SELECT id FROM memories WHERE id=? AND project_id IS ?")
            .get(prior.memory_id, projectId)
        : null;
      if (existing && prior?.content_hash === hash) return;
      const fields = {
        content,
        title: basename(actual, ".md"),
        type: "fact" as const,
        source: `claude:auto-memory:${actual}`,
        tags: ["agent-memory", "agent:claude"],
        scope: `agent-memory:${key}`,
      };
      let id: string;
      if (existing && prior) {
        memories.update(prior.memory_id, fields, {
          actor: "claude-memory-sync",
          session_id: event.session_id,
        });
        id = prior.memory_id;
      } else {
        const result = memories.store({
          ...fields,
          project_id: projectId,
          actor: "claude-memory-sync",
          session_id: event.session_id,
        });
        id = result.status === "skipped" ? result.existing_id : result.id;
      }
      db.query(
        "INSERT INTO agent_memory_sources(source_key,source_path,project_id,memory_id,content_hash,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET memory_id=excluded.memory_id,content_hash=excluded.content_hash,updated_at=excluded.updated_at",
      ).run(key, actual, projectId, id, hash, Date.now());
      updated++;
    })();
  }
  return updated;
}
