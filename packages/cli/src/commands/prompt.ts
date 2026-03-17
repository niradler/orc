import { createOrcClient } from "@orc/sdk/client";
import { Command } from "commander";
import { dryRunMsg, isDryRun, isJson, jsonErr, jsonOut } from "../output.js";

export function promptCommand() {
  const cmd = new Command("prompt").description("Manage prompts and skills");

  cmd
    .command("list")
    .description("List prompts")
    .option("--skill", "Show skills only")
    .option("-l, --limit <n>", "Max results", "20")
    .action(async (opts) => {
      const client = createOrcClient();
      const { data, error } = await client.prompts.list({
        limit: Number(opts.limit),
      });
      if (error) return console.error("Error:", error);
      let prompts = data?.prompts ?? [];
      if (opts.skill) prompts = prompts.filter((p) => p.is_skill);
      if (isJson()) return jsonOut({ prompts });
      if (prompts.length === 0) return console.log("No prompts found.");

      for (const p of prompts) {
        const id = p.id.slice(-6);
        const skill = p.is_skill ? color(" [skill]", "36") : "";
        const ver = color(`v${p.version}`, "2");
        const name = p.name.length > 40 ? p.name.slice(0, 39) + "…" : p.name;
        console.log(`  [${id}] ${name.padEnd(42)} ${ver}${skill}`);
      }
    });

  cmd
    .command("show <id>")
    .description("Show prompt details")
    .action(async (id: string) => {
      const client = createOrcClient();
      const full = await resolvePromptId(client, id);
      if (!full) return;
      const { data, error } = await client.prompts.get(full);
      if (error) return console.error("Error:", error);
      if (!data) return console.error("Prompt not found.");
      if (isJson()) return jsonOut(data);

      console.log(color(data.name, "1"));
      console.log();
      if (data.description) console.log(`  ${data.description}`);
      console.log(`  id:          ${data.id}`);
      console.log(`  version:     ${data.version}`);
      console.log(`  is_skill:    ${data.is_skill}`);
      if (data.skill_dir) console.log(`  skill_dir:   ${data.skill_dir}`);
      if (data.skill_version) console.log(`  skill_ver:   ${data.skill_version}`);
      console.log(`  pinned:      ${data.pinned}`);
      if (data.tags?.length) console.log(`  tags:        ${data.tags.join(", ")}`);
      if (data.last_used_at) console.log(`  last_used:   ${data.last_used_at}`);
      console.log(`  created:     ${data.created_at}`);
      console.log(`  updated:     ${data.updated_at}`);
      console.log();
      console.log(color("── template ─────────────────────────────", "2"));
      console.log(data.template);
    });

  cmd
    .command("add <name>")
    .description("Create a new prompt")
    .option("-c, --content <text>", "Prompt template content")
    .option("-m, --model <model>", "Model name")
    .option("-t, --temperature <t>", "Temperature")
    .option("--skill", "Mark as skill")
    .option("--variables <csv>", "Comma-separated variable names")
    .option("-d, --description <text>", "Description")
    .option("--tags <csv>", "Comma-separated tags")
    .option("--pinned", "Pin this prompt")
    .action(async (name: string, opts) => {
      const client = createOrcClient();
      const template = opts.content ?? "";
      const { data, error } = await client.prompts.create({
        name,
        template,
        description: opts.description,
        is_skill: opts.skill ?? false,
        tags: opts.tags ? opts.tags.split(",").map((s: string) => s.trim()) : undefined,
        pinned: opts.pinned ?? false,
      });
      if (error) return console.error("Error:", error);
      if (isJson()) return jsonOut(data);
      console.log(`Created: [${data?.id.slice(-6)}] ${data?.name}`);
    });

  cmd
    .command("update <id>")
    .description("Update a prompt")
    .option("-c, --content <text>", "Prompt template content")
    .option("-n, --name <name>", "Prompt name")
    .option("-m, --model <model>", "Model name")
    .option("-t, --temperature <t>", "Temperature")
    .option("--skill", "Mark as skill")
    .option("--no-skill", "Unmark as skill")
    .option("--variables <csv>", "Comma-separated variable names")
    .option("-d, --description <text>", "Description")
    .option("--tags <csv>", "Comma-separated tags")
    .option("--pinned", "Pin this prompt")
    .option("--no-pinned", "Unpin this prompt")
    .action(async (id: string, opts) => {
      const client = createOrcClient();
      const full = await resolvePromptId(client, id);
      if (!full) return;

      const input: Record<string, unknown> = {};
      if (opts.content !== undefined) input.template = opts.content;
      if (opts.name !== undefined) input.name = opts.name;
      if (opts.description !== undefined) input.description = opts.description;
      if (opts.skill !== undefined) input.is_skill = opts.skill;
      if (opts.tags) input.tags = opts.tags.split(",").map((s: string) => s.trim());
      if (opts.pinned !== undefined) input.pinned = opts.pinned;

      if (isDryRun()) return dryRunMsg("update", `prompt [${full.slice(-6)}]`, input);
      const { data, error } = await client.prompts.update(full, input);
      if (error) return console.error("Error:", error);
      if (isJson()) return jsonOut(data);
      console.log(`Updated: [${data?.id.slice(-6)}] ${data?.name}`);
    });

  cmd
    .command("delete <id>")
    .description("Delete a prompt")
    .action(async (id: string) => {
      const client = createOrcClient();
      const full = await resolvePromptId(client, id);
      if (!full) return;
      if (isDryRun()) return dryRunMsg("delete", `prompt ${full}`);
      const { error } = await client.prompts.delete(full);
      if (error) return console.error("Error:", error);
      if (isJson()) return jsonOut({ deleted: full });
      console.log(`Deleted: ${full}`);
    });

  cmd
    .command("render <id>")
    .description("Render a prompt with variables")
    .option("--var <key=value>", "Variable (repeatable)", collect, [])
    .action(async (id: string, opts) => {
      const client = createOrcClient();
      const full = await resolvePromptId(client, id);
      if (!full) return;

      const vars: Record<string, string> = {};
      for (const v of opts.var as string[]) {
        const eq = v.indexOf("=");
        if (eq === -1) {
          return console.error(`Invalid variable format: ${v} (expected key=value)`);
        }
        vars[v.slice(0, eq)] = v.slice(eq + 1);
      }

      const { data, error } = await client.prompts.render(full, vars);
      if (error) return console.error("Error:", error);
      if (isJson()) return jsonOut(data);
      console.log(data?.rendered);
    });

  cmd
    .command("history <id>")
    .description("Show version history")
    .option("-l, --limit <n>", "Max results", "20")
    .action(async (id: string, opts) => {
      const client = createOrcClient();
      const full = await resolvePromptId(client, id);
      if (!full) return;
      const { data, error } = await client.prompts.history(full, Number(opts.limit));
      if (error) return console.error("Error:", error);
      const history = data?.history ?? [];
      if (isJson()) return jsonOut({ history });
      if (history.length === 0) return console.log("No history found.");

      for (const h of history) {
        const date = h.changed_at.slice(0, 19).replace("T", " ");
        console.log(
          `  v${String(h.version).padEnd(4)} ${color(date, "2")}  by ${h.changed_by}  ${h.name}`,
        );
      }
    });

  return cmd;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

async function resolvePromptId(
  client: ReturnType<typeof createOrcClient>,
  input: string,
): Promise<string | null> {
  if (input.length === 26) return input;
  const { data } = await client.prompts.list({ limit: 200 });
  const match = (data?.prompts ?? []).find((p) => p.id.endsWith(input) || p.id === input);
  if (!match) {
    console.error(`Prompt not found: ${input}`);
    return null;
  }
  return match.id;
}

function color(text: string, code: string): string {
  return process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
}
