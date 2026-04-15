import { createOrcClient } from "@orc/sdk/client";
import { Command } from "commander";
import { isJson, jsonOut } from "../output.js";
import { resolveProject } from "./project.js";

export function kbCommand() {
  const cmd = new Command("kb").description("Manage knowledge base collections");

  cmd
    .command("search <query>")
    .description("Search indexed documents")
    .option("-c, --collection <name>", "Filter by collection")
    .option("-l, --limit <n>", "Max results", "10")
    .option("-m, --mode <mode>", "Search mode (hybrid|lexical)")
    .option("-p, --project <name>", "Filter by project name")
    .option("--no-project", "Search all collections")
    .action(async (query: string, opts) => {
      const client = createOrcClient();
      const noProject = opts.project === false;
      const project = noProject
        ? null
        : await resolveProject(client, { project: opts.project, noProject });
      const { data, error } = await client.knowledge.search(query, {
        collection: opts.collection,
        ...(project ? { project_id: project.id } : {}),
        mode: opts.mode,
        limit: Number(opts.limit),
      });
      if (error) return console.error("Error:", error);
      const results = data?.results ?? [];
      if (isJson()) return jsonOut({ results });
      if (results.length === 0) return console.log("No documents found.");
      for (const r of results) {
        const col = r.collection ? `[${r.collection}]` : "";
        const score = r.score.toFixed(2);
        console.log(`• ${r.title || r.path} ${col} (score: ${score})`);
        if (r.snippet) console.log(`  ${r.snippet.slice(0, 100)}`);
      }
    });

  cmd
    .command("get <id>")
    .description("Get full document content by docid or path")
    .action(async (id: string) => {
      const client = createOrcClient();
      const { data, error } = await client.knowledge.get(id);
      if (error) return console.error("Error:", error);
      if (!data) return console.error("Document not found.");
      if (isJson()) return jsonOut(data);

      console.log(`Title:      ${data.title}`);
      console.log(`Path:       ${data.path}`);
      console.log(`Collection: ${data.collection}`);
      console.log(`Modified:   ${data.modifiedAt}`);
      console.log();
      console.log(data.content);
    });

  cmd
    .command("collections")
    .description("List indexed collections")
    .option("-p, --project <name>", "Filter by project name")
    .option("--no-project", "Show all collections")
    .action(async (opts) => {
      const client = createOrcClient();
      const noProject = opts.project === false;
      const project = noProject
        ? null
        : await resolveProject(client, { project: opts.project, noProject });
      const { data, error } = await client.knowledge.collections(
        project ? { project_id: project.id } : undefined,
      );
      if (error) return console.error("Error:", error);
      const cols = data?.collections ?? [];
      if (isJson()) return jsonOut({ collections: cols });
      if (cols.length === 0) return console.log("No collections found.");
      for (const c of cols) {
        const docs = `${c.documentCount} docs`;
        const proj = c.projectId ? ` [project: ${c.projectId}]` : "";
        console.log(`• ${c.name.padEnd(24)} ${c.path}  (${docs})${proj}`);
        console.log(`  pattern: ${c.pattern}`);
      }
    });

  cmd
    .command("add <name>")
    .description("Add a new collection and index it")
    .requiredOption("--path <dir>", "Directory path to index")
    .option("--pattern <glob>", "File glob pattern", "**/*.md")
    .option("-p, --project <name>", "Associate with project")
    .option("--no-project", "Create without project")
    .action(async (name: string, opts) => {
      const client = createOrcClient();
      const noProject = opts.project === false;
      const project = noProject
        ? null
        : await resolveProject(client, { project: opts.project, noProject });
      const { data, error } = await client.knowledge.addCollection({
        name,
        path: opts.path,
        pattern: opts.pattern,
        ...(project ? { project_id: project.id } : {}),
      });
      if (error) return console.error("Error:", error);
      if (isJson()) return jsonOut(data);
      console.log(`Added collection "${data?.name}" — indexed ${data?.indexed} documents`);
    });

  cmd
    .command("remove <name>")
    .description("Remove a collection")
    .action(async (name: string) => {
      const client = createOrcClient();
      const { error } = await client.knowledge.removeCollection(name);
      if (error) return console.error("Error:", error);
      if (isJson()) return jsonOut({ removed: name });
      console.log(`Removed collection: ${name}`);
    });

  cmd
    .command("update")
    .description("Re-index collections (scan for new/changed/deleted files)")
    .option("-c, --collections <names>", "Comma-separated collection names to re-index")
    .action(async (opts) => {
      const client = createOrcClient();
      const collections = opts.collections
        ? (opts.collections as string).split(",").map((s: string) => s.trim())
        : undefined;
      const { data, error } = await client.knowledge.update(
        collections ? { collections } : undefined,
      );
      if (error) return console.error("Error:", error);
      if (isJson()) return jsonOut(data);
      console.log(
        `Re-indexed: ${data?.indexed} new, ${data?.updated} updated, ${data?.removed} removed`,
      );
    });

  cmd
    .command("status")
    .description("Show knowledge engine status")
    .action(async () => {
      const client = createOrcClient();
      const { data, error } = await client.knowledge.status();
      if (error) return console.error("Error:", error);
      if (!data) return console.error("Could not get status.");
      if (isJson()) return jsonOut(data);

      console.log(`DB path:     ${data.dbPath}`);
      console.log(`Search mode: ${data.searchMode}`);
      console.log(`Total docs:  ${data.totalDocuments}`);
      console.log(`Collections: ${data.collections.length}`);
      if (data.collections.length > 0) {
        console.log();
        for (const c of data.collections) {
          console.log(`  • ${c.name.padEnd(24)} ${c.documentCount} docs  ${c.path}`);
        }
      }
    });

  return cmd;
}
