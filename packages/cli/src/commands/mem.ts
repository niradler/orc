import { createOrcClient } from "@orc/sdk/client";
import { Command } from "commander";

export function memCommand() {
  const cmd = new Command("mem").description("Manage memory");

  cmd
    .command("search <query>")
    .description("Search memories")
    .option("-s, --scope <scope>", "Scope filter")
    .option("-l, --limit <n>", "Max results", "10")
    .action(async (query: string, opts) => {
      const client = createOrcClient();
      const { data, error } = await client.memories.search(query, opts.scope, Number(opts.limit));
      if (error) return console.error("Error:", error);
      const results = data?.results ?? [];
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
    .option("--source <source>", "Source reference")
    .option("--importance <level>", "Importance (low/normal/high/critical)", "normal")
    .option("-t, --tags <tags>", "Comma-separated tags")
    .action(async (content: string, opts) => {
      const client = createOrcClient();
      const { data, error } = await client.memories.create({
        content,
        scope: opts.scope,
        source: opts.source,
        importance: opts.importance,
        ...(opts.tags
          ? { tags: (opts.tags as string).split(",").map((t: string) => t.trim()) }
          : {}),
      });
      if (error) return console.error("Error:", error);
      console.log(`Stored: [${data!.id.slice(-6)}] ${data!.content.slice(0, 60)}`);
    });

  cmd
    .command("list")
    .description("List recent memories")
    .option("-s, --scope <scope>", "Scope filter")
    .option("-l, --limit <n>", "Max results", "20")
    .action(async (opts) => {
      const client = createOrcClient();
      const { data, error } = await client.memories.list({
        scope: opts.scope,
        limit: Number(opts.limit),
      });
      if (error) return console.error("Error:", error);
      const mems = data?.memories ?? [];
      if (mems.length === 0) return console.log("No memories found.");
      for (const m of mems) {
        const age = formatAge(m.created_at);
        const scope = m.scope ? `[${m.scope}]` : "";
        console.log(`• [${m.id.slice(-6)}] ${m.content.slice(0, 70)} ${scope} ${age}`);
      }
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
