import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createOrcClient } from "@orc/sdk/client";
import type { ApiResult, Memory, MemoryListSort, UpdateMemoryInput } from "@orc/sdk/types";
import { Command } from "commander";
import { isJson, jsonOut } from "../output.js";
import { resolveProject } from "./project.js";

const AUTHOR = "cli";
const SORTS: MemoryListSort[] = ["reads", "recent", "priority"];

/** The calling agent's native session id, recorded on every change. */
function sessionId(): string | undefined {
  return process.env.ORC_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || undefined;
}

function writer() {
  const session_id = sessionId();
  return { author: AUTHOR, ...(session_id ? { session_id } : {}) };
}

function unwrap<T>(result: ApiResult<T>): T {
  if (result.error) {
    console.error(`Error: ${result.error.error}`);
    process.exit(1);
  }
  return result.data as T;
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parsePriority(value: string, allowNone: boolean): number | null {
  if (allowNone && value === "none") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100)
    fail(`priority must be an integer 0-100${allowNone ? ' or "none"' : ""}, got: ${value}`);
  return n;
}

function formatPriority(priority: number | null): string {
  return priority === null ? "-" : `p${priority}`;
}

function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace("T", " ").slice(0, 19);
}

async function projectFrom(opts: { project?: string }) {
  const client = createOrcClient({ source: "cli" });
  const project = await resolveProject(client, { project: opts.project });
  if (!project) fail("No project resolved");
  return { client, project };
}

function printMemory(mem: Memory, projectName: string) {
  console.log(`# ${mem.name}  (${projectName}, ${formatPriority(mem.priority)})`);
  console.log(`  ${mem.description}`);
  console.log(`  author: ${mem.author}  updated: ${formatTime(mem.updated_at)}`);
  console.log();
  console.log(mem.content);
}

export function memCommand() {
  const cmd = new Command("mem").description(
    "Manage project memories: short facts worth knowing next session (use a skill for procedures)",
  );

  cmd
    .command("list")
    .description("List the project's memories, most read first")
    .option("-q, --q <text>", "Search name and description")
    .option("-s, --sort <sort>", `Sort order (${SORTS.join("|")})`)
    .option("-l, --limit <n>", "Max results", "30")
    .option("-p, --project <name>", "Project name (defaults to the active project)")
    .action(async (opts: { q?: string; sort?: string; limit: string; project?: string }) => {
      if (opts.sort && !SORTS.includes(opts.sort as MemoryListSort))
        fail(`sort must be one of ${SORTS.join(", ")}`);
      const { client, project } = await projectFrom(opts);
      const data = unwrap(
        await client.memories.list({
          project_id: project.id,
          q: opts.q,
          sort: opts.sort as MemoryListSort | undefined,
          limit: Number(opts.limit),
        }),
      );
      if (isJson()) return jsonOut(data);
      if (data.memories.length === 0) return console.log("No memories found.");
      for (const m of data.memories) {
        console.log(
          `  ${m.name.padEnd(32)} ${formatPriority(m.priority).padStart(4)}  ${m.description}`,
        );
      }
      if (data.total > data.memories.length)
        console.log(`  ... ${data.total - data.memories.length} more (use --limit)`);
    });

  cmd
    .command("show <name>")
    .description("Show a memory")
    .option("-p, --project <name>", "Project name (defaults to the active project)")
    .action(async (name: string, opts: { project?: string }) => {
      const { client, project } = await projectFrom(opts);
      const mem = unwrap(await client.memories.get(project.id, name));
      if (isJson()) return jsonOut(mem);
      printMemory(mem, project.name);
    });

  cmd
    .command("add <name>")
    .description("Create a memory (lowercase-hyphenated name)")
    .requiredOption("-d, --description <text>", "One-line summary shown in lists and context")
    .requiredOption("-c, --content <text>", "The fact itself (short; long guidance is a skill)")
    .option("--priority <n>", "0-100, higher loads first in context")
    .option("-p, --project <name>", "Project name (defaults to the active project)")
    .action(
      async (
        name: string,
        opts: { description: string; content: string; priority?: string; project?: string },
      ) => {
        const priority =
          opts.priority === undefined ? undefined : parsePriority(opts.priority, false);
        const { client, project } = await projectFrom(opts);
        const mem = unwrap(
          await client.memories.create({
            project_id: project.id,
            name,
            description: opts.description,
            content: opts.content,
            ...(priority === undefined ? {} : { priority }),
            ...writer(),
          }),
        );
        if (isJson()) return jsonOut(mem);
        console.log(`Created memory ${mem.name} in ${project.name}`);
      },
    );

  cmd
    .command("edit <name>")
    .description("Update a memory's description, content or priority")
    .option("-d, --description <text>", "New description")
    .option("-c, --content <text>", "New content")
    .option("--priority <n>", '0-100, or "none" to clear')
    .option("-r, --reason <text>", "Why the memory changed (kept in history)")
    .option("-p, --project <name>", "Project name (defaults to the active project)")
    .action(
      async (
        name: string,
        opts: {
          description?: string;
          content?: string;
          priority?: string;
          reason?: string;
          project?: string;
        },
      ) => {
        const fields: UpdateMemoryInput = {};
        if (opts.description !== undefined) fields.description = opts.description;
        if (opts.content !== undefined) fields.content = opts.content;
        if (opts.priority !== undefined) fields.priority = parsePriority(opts.priority, true);
        if (Object.keys(fields).length === 0)
          fail("Nothing to update: pass --description, --content or --priority");
        const { client, project } = await projectFrom(opts);
        const mem = unwrap(
          await client.memories.update(project.id, name, {
            ...fields,
            ...(opts.reason ? { reason: opts.reason } : {}),
            ...writer(),
          }),
        );
        if (isJson()) return jsonOut(mem);
        console.log(`Updated memory ${mem.name} in ${project.name}`);
      },
    );

  cmd
    .command("delete <name>")
    .description("Delete a memory (revertible from its history)")
    .option("-p, --project <name>", "Project name (defaults to the active project)")
    .action(async (name: string, opts: { project?: string }) => {
      const { client, project } = await projectFrom(opts);
      unwrap(await client.memories.delete(project.id, name, writer()));
      if (isJson()) return jsonOut({ deleted: name, project_id: project.id });
      console.log(`Deleted memory ${name} from ${project.name}`);
    });

  cmd
    .command("history <name>")
    .description("List changes to a memory, newest first")
    .option("-p, --project <name>", "Project name (defaults to the active project)")
    .action(async (name: string, opts: { project?: string }) => {
      const { client, project } = await projectFrom(opts);
      const data = unwrap(await client.memories.history(project.id, name));
      if (isJson()) return jsonOut(data);
      if (data.changes.length === 0) return console.log("No history.");
      for (const change of data.changes) {
        const reason = change.reason ? `: ${change.reason}` : "";
        console.log(
          `${change.id}  ${formatTime(change.created_at)}  ${change.action.padEnd(16)} ${change.author}${reason}`,
        );
      }
    });

  cmd
    .command("revert <name> <change-id>")
    .description("Restore a memory to its state before a change")
    .requiredOption("-r, --reason <text>", "Reason for the revert")
    .requiredOption("--expected-change-id <id>", "Latest change id from history")
    .option("-p, --project <name>", "Project name (defaults to the active project)")
    .action(
      async (
        name: string,
        changeId: string,
        opts: { reason: string; expectedChangeId: string; project?: string },
      ) => {
        const { client, project } = await projectFrom(opts);
        const data = unwrap(
          await client.memories.revert(project.id, name, {
            change_id: changeId,
            expected_change_id: opts.expectedChangeId,
            reason: opts.reason,
            ...writer(),
          }),
        );
        if (isJson()) return jsonOut(data);
        console.log(
          data.memory
            ? `Reverted memory ${name} in ${project.name}`
            : `Reverted memory ${name} in ${project.name}; it no longer exists`,
        );
      },
    );

  cmd
    .command("sources")
    .description(
      "List native memory folders: Claude Code project memory (the project's first) and Codex notes",
    )
    .option("-p, --project <name>", "Project name (defaults to the active project)")
    .action(async (opts: { project?: string }) => {
      const { client, project } = await projectFrom(opts);
      const data = unwrap(await client.memories.nativeSources(project.id));
      if (isJson()) return jsonOut(data);
      if (data.sources.length === 0) return console.log("No native memory folders found.");
      for (const source of data.sources)
        console.log(
          `  ${source.project_match ? "*" : " "} ${source.agent.padEnd(6)} ${String(source.count).padStart(3)}  ${source.dir}`,
        );
    });

  cmd
    .command("import [dir]")
    .description(
      "Import native memory files (Claude format) into the project; lists them unless --all or --name",
    )
    .option("-n, --name <names...>", "Import these memories")
    .option("--all", "Import every new memory")
    .option("--replace <names...>", "Update these project memories from the folder")
    .option("-p, --project <name>", "Project name (defaults to the active project)")
    .action(
      async (
        dirArg: string | undefined,
        opts: { name?: string[]; all?: boolean; replace?: string[]; project?: string },
      ) => {
        const { client, project } = await projectFrom(opts);
        const dir = await nativeDir(client, project, dirArg);
        const preview = unwrap(
          await client.memories.previewImport(project.id, readMemoryFiles(dir), dir),
        );
        if (!opts.all && !opts.name && !opts.replace) {
          if (isJson()) return jsonOut(preview);
          console.log(preview.dir);
          for (const memory of preview.memories) {
            console.log(
              `  [${memory.status}] ${memory.name} - ${memory.error ?? memory.description}`,
            );
            if (memory.match) console.log(`      ${matchText(memory.match)}`);
          }
          return;
        }
        const names = new Set([
          ...(opts.all
            ? preview.memories.filter((memory) => memory.status === "new").map((m) => m.name)
            : []),
          ...(opts.name ?? []),
        ]);
        const replace = new Set(opts.replace ?? []);
        const items = [...new Set([...names, ...replace])].map((name) => ({
          name,
          ...(replace.has(name) ? { replace: true } : {}),
        }));
        if (!items.length) fail("No new memories to import");
        const result = unwrap(
          await client.memories.importNative(project.id, readMemoryFiles(dir), items, dir),
        );
        if (isJson()) return jsonOut(result);
        for (const name of result.imported) console.log(`Imported ${name}`);
        for (const name of result.replaced) console.log(`Replaced ${name}`);
        for (const skip of result.skipped) console.log(`Skipped ${skip.name}: ${skip.reason}`);
      },
    );

  cmd
    .command("export [dir]")
    .description(
      "Write project memories as native memory files (Claude format, MEMORY.md index); defaults to the project's Claude memory folder",
    )
    .option("-n, --name <names...>", "Export only these memories")
    .option("--overwrite <names...>", "Write these even if the folder has a near copy or conflict")
    .option(
      "--overwrite-all",
      "Write every memory the folder has a near copy, conflict or duplicate of",
    )
    .option("--dry-run", "Show what would happen without writing")
    .option("-p, --project <name>", "Project name (defaults to the active project)")
    .action(
      async (
        dirArg: string | undefined,
        opts: {
          name?: string[];
          overwrite?: string[];
          overwriteAll?: boolean;
          dryRun?: boolean;
          project?: string;
        },
      ) => {
        const { client, project } = await projectFrom(opts);
        const dir = await nativeDir(client, project, dirArg);
        const index = memoryIndex(dir);
        const plan = unwrap(
          await client.memories.previewExport(
            project.id,
            readMemoryFiles(dir),
            opts.name,
            dir,
            index.maintain,
          ),
        );
        if (opts.dryRun) {
          if (isJson()) return jsonOut(plan);
          console.log(plan.dir);
          for (const item of plan.memories) {
            console.log(`  [${item.status}] ${item.name}${item.reason ? ` - ${item.reason}` : ""}`);
            if (item.match) console.log(`      ${matchText(item.match)}`);
          }
          return;
        }
        const overwrite = opts.overwriteAll
          ? plan.memories.filter((item) => item.can_overwrite).map((item) => item.name)
          : opts.overwrite;
        const result = unwrap(
          await client.memories.exportNative(project.id, readMemoryFiles(dir), {
            names: opts.name,
            overwrite,
            dir,
            index: index.content,
            maintain_index: index.maintain,
          }),
        );
        const written = writeMemoryExport(dir, result);
        if (isJson()) return jsonOut({ ...result, exported: written });
        for (const item of written)
          console.log(
            `${item.replaced ? "Replaced" : "Exported"} ${item.name} -> ${item.file}${item.backup ? ` (backup ${item.backup})` : ""}`,
          );
        for (const skip of result.skipped) console.log(`Skipped ${skip.name}: ${skip.reason}`);
        if (result.index_updated) console.log("Updated MEMORY.md");
      },
    );

  return cmd;
}

function matchText(match: { name: string; level: string; score: number; where: string }): string {
  const where = match.where === "orc" ? "in ORC" : "in the folder";
  return `${match.level} to ${match.name} ${where} (${Math.round(match.score * 100)}%)`;
}

function readMemoryFiles(dir: string): Array<{ file: string; content: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.md$/i.test(name) && name.toLowerCase() !== "memory.md")
    .sort()
    .map((file) => ({ file, content: readFileSync(join(dir, file), "utf8") }));
}

function memoryIndex(dir: string): { maintain: boolean; content: string | null } {
  const index = join(dir, "MEMORY.md");
  const claudeRoot = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  const claude = basename(dir) === "memory" && dirname(dirname(dir)) === claudeRoot;
  const exists = existsSync(index);
  return { maintain: exists || claude, content: exists ? readFileSync(index, "utf8") : null };
}

function writeMemoryExport(
  dir: string,
  result: {
    files?: Array<{ name: string; file: string; content: string; replaced: boolean }> | undefined;
    index_content?: string | null | undefined;
    index_updated?: boolean | undefined;
  },
): Array<{ name: string; file: string; replaced: boolean; backup?: string }> {
  mkdirSync(dir, { recursive: true });
  const written = [];
  for (const file of result.files ?? []) {
    const path = join(dir, basename(file.file));
    let backup: string | undefined;
    if (file.replaced && existsSync(path)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      backup = join(homedir(), ".orc", "memory-export-backups", stamp, basename(path));
      mkdirSync(dirname(backup), { recursive: true });
      copyFileSync(path, backup);
    }
    writeFileSync(path, file.content);
    written.push({
      name: file.name,
      file: path,
      replaced: file.replaced,
      ...(backup ? { backup } : {}),
    });
  }
  if (result.index_content) writeFileSync(join(dir, "MEMORY.md"), result.index_content);
  return written;
}

/** The given folder, or the Claude memory folder matching the project. */
async function nativeDir(
  client: ReturnType<typeof createOrcClient>,
  project: { id: string; name: string },
  dir: string | undefined,
): Promise<string> {
  if (dir) return resolve(dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir);
  const { sources } = unwrap(await client.memories.nativeSources(project.id));
  const match = sources.find((source) => source.project_match);
  if (!match)
    fail(`No Claude memory folder matches project ${project.name}; pass the folder explicitly`);
  return match.dir;
}
