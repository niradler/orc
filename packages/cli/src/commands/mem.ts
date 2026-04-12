import { shortId } from "@orc/core/ids";
import { createOrcClient } from "@orc/sdk/client";
import { Command } from "commander";
import { isJson, jsonOut } from "../output.js";
import { resolveProject } from "./project.js";

export function memCommand() {
  const cmd = new Command("mem").description("Manage memory");

  cmd
    .command("search <query>")
    .description("Search memories")
    .option("-s, --scope <scope>", "Scope filter")
    .option("-l, --limit <n>", "Max results", "10")
    .option("-p, --project <name>", "Filter by project name")
    .option("--no-project", "Search all memories")
    .action(async (query: string, opts) => {
      const client = createOrcClient();
      const noProject = opts.project === false;
      const project = noProject
        ? null
        : await resolveProject(client, { project: opts.project, noProject });
      const { data, error } = await client.memories.search(query, {
        scope: opts.scope,
        ...(project ? { project_id: project.id } : {}),
        limit: Number(opts.limit),
      });
      if (error) return console.error("Error:", error);
      const results = data?.results ?? [];
      if (isJson()) return jsonOut({ results });
      if (results.length === 0) return console.log("No memories found.");
      for (const m of results) {
        const age = formatAge(m.created_at);
        const scope = m.scope ? `[${m.scope}]` : "";
        console.log(`• ${m.content.slice(0, 80)} ${scope} ${age}`);
      }
    });

  cmd
    .command("add <content>")
    .description("Store a memory")
    .option("-s, --scope <scope>", "Scope")
    .option("--type <type>", "Type (fact/decision/event/rule/discovery)", "fact")
    .option("--source <source>", "Source reference")
    .option("--importance <level>", "Importance (low/normal/high/critical)", "normal")
    .option("-t, --tags <tags>", "Comma-separated tags")
    .option("-p, --project <name>", "Project name")
    .option("--no-project", "Create without project")
    .action(async (content: string, opts) => {
      const client = createOrcClient();
      const noProject = opts.project === false;
      const project = noProject
        ? null
        : await resolveProject(client, { project: opts.project, noProject });
      const { data, error } = await client.memories.create({
        content,
        ...(project ? { project_id: project.id } : {}),
        type: opts.type,
        scope: opts.scope,
        source: opts.source,
        importance: opts.importance,
        ...(opts.tags
          ? { tags: (opts.tags as string).split(",").map((t: string) => t.trim()) }
          : {}),
      });
      if (error) return console.error("Error:", error);
      if (isJson()) return jsonOut(data);
      console.log(`Stored: [${shortId(data?.id)}] [${opts.type}] ${data?.content.slice(0, 60)}`);
    });

  cmd
    .command("list")
    .description("List recent memories")
    .option("-s, --scope <scope>", "Scope filter")
    .option("-l, --limit <n>", "Max results", "20")
    .option("-p, --project <name>", "Filter by project name")
    .option("--no-project", "Show all memories")
    .action(async (opts) => {
      const client = createOrcClient();
      const noProject = opts.project === false;
      const project = noProject
        ? null
        : await resolveProject(client, { project: opts.project, noProject });
      const { data, error } = await client.memories.list({
        scope: opts.scope,
        ...(project ? { project_id: project.id } : {}),
        limit: Number(opts.limit),
      });
      if (error) return console.error("Error:", error);
      const mems = data?.memories ?? [];
      if (isJson()) return jsonOut({ memories: mems });
      if (mems.length === 0) return console.log("No memories found.");
      for (const m of mems) {
        const age = formatAge(m.created_at);
        const scope = m.scope ? `[${m.scope}]` : "";
        console.log(`• [${shortId(m.id)}] ${m.content.slice(0, 70)} ${scope} ${age}`);
      }
    });

  cmd
    .command("show <id>")
    .description("Show memory details")
    .action(async (id: string) => {
      const client = createOrcClient();
      const { data, error } = await client.memories.list({ limit: 100 });
      if (error) return console.error("Error:", error);
      const mem = (data?.memories ?? []).find((m) => m.id === id || m.id.endsWith(id));
      if (!mem) return console.error(`Memory not found: ${id}`);
      if (isJson()) return jsonOut(mem);

      const fields: [string, unknown][] = [
        ["ID", mem.id],
        ["Content", mem.content],
        ["Scope", mem.scope],
        ["Source", mem.source],
        ["Importance", mem.importance],
        ["Project ID", mem.project_id],
        ["Tags", mem.tags?.join(", ")],
        ["Expires", mem.expires_at],
        ["Created", mem.created_at],
        ["Updated", mem.updated_at],
      ];

      for (const [label, value] of fields) {
        if (value !== undefined && value !== null && value !== "")
          console.log(`${label.padEnd(14)} ${value}`);
      }
    });

  cmd
    .command("edit <id>")
    .description("Update a memory")
    .option("--content <content>", "New content")
    .option("--title <title>", "New title")
    .option("--type <type>", "New type (fact/decision/event/rule/discovery)")
    .option("-s, --scope <scope>", "New scope")
    .option("--source <source>", "New source reference")
    .option("--importance <level>", "New importance (low/normal/high/critical)")
    .option("-t, --tags <tags>", "Comma-separated tags")
    .action(async (id: string, opts) => {
      const client = createOrcClient();
      const { data: listData, error: listErr } = await client.memories.list({ limit: 100 });
      if (listErr) return console.error("Error:", listErr);
      const mem = (listData?.memories ?? []).find((m) => m.id === id || m.id.endsWith(id));
      if (!mem) return console.error(`Memory not found: ${id}`);

      const input: Record<string, unknown> = {};
      if (opts.content) input.content = opts.content;
      if (opts.title) input.title = opts.title;
      if (opts.type) input.type = opts.type;
      if (opts.scope) input.scope = opts.scope;
      if (opts.source) input.source = opts.source;
      if (opts.importance) input.importance = opts.importance;
      if (opts.tags) input.tags = (opts.tags as string).split(",").map((t: string) => t.trim());

      if (Object.keys(input).length === 0) return console.error("No fields to update.");

      const { data, error } = await client.memories.update(mem.id, input);
      if (error) return console.error("Error:", error);
      if (isJson()) return jsonOut(data);
      console.log(`Updated: [${shortId(data?.id)}] [${data?.type}] ${data?.content.slice(0, 60)}`);
    });

  cmd
    .command("delete <id>")
    .description("Delete a memory")
    .action(async (id: string) => {
      const client = createOrcClient();
      const { data, error: listErr } = await client.memories.list({ limit: 100 });
      if (listErr) return console.error("Error:", listErr);
      const mem = (data?.memories ?? []).find((m) => m.id === id || m.id.endsWith(id));
      if (!mem) return console.error(`Memory not found: ${id}`);

      const { error } = await client.memories.delete(mem.id);
      if (error) return console.error("Error:", error);
      if (isJson()) return jsonOut({ deleted: mem.id });
      console.log(`Deleted memory: [${shortId(mem.id)}] ${mem.content.slice(0, 60)}`);
    });

  return cmd;
}

function formatAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
