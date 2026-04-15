import { readFileSync } from "node:fs";
import { createOrcClient } from "@orc/sdk/client";
import type { SkillFull, SkillRefContent } from "@orc/sdk/types";
import { Command } from "commander";
import { isJson, jsonOut } from "../output.js";

function color(text: string, code: string) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

export function skillCommand() {
  const cmd = new Command("skill").description("Manage skills");

  cmd
    .command("list")
    .description("List installed skills")
    .option("-q, --query <q>", "Keyword search")
    .option("--source <source>", "Filter by source (builtin|user)")
    .option("--reload", "Force cache rebuild")
    .action(async (opts) => {
      const client = createOrcClient();
      const { data, error } = await client.skills.list({
        q: opts.query,
        source: opts.source,
        reload: opts.reload,
      });
      if (error) return console.error("Error:", error);
      const skills = data?.skills ?? [];
      if (isJson()) return jsonOut({ skills });
      if (skills.length === 0) return console.log("No skills found.");

      for (const s of skills) {
        const src = s.source === "user" ? color(" [user]", "36") : "";
        const name = s.name.length > 30 ? `${s.name.slice(0, 29)}…` : s.name;
        const desc = s.description ? ` - ${s.description.slice(0, 50)}` : "";
        console.log(`  ${name.padEnd(32)}${src}${desc}`);
      }
    });

  cmd
    .command("read <name>")
    .description("Read a skill")
    .option("--ref <filename>", "Read a specific reference file")
    .action(async (name: string, opts) => {
      const client = createOrcClient();
      const { data, error } = await client.skills.read(name, opts.ref);
      if (error) return console.error("Error:", error);
      if (!data) return console.error("Skill not found.");
      if (isJson()) return jsonOut(data);

      if (opts.ref) {
        const ref = data as SkillRefContent;
        console.log(color(`# ${ref.name}`, "1"));
        console.log();
        console.log(ref.content);
      } else {
        const skill = data as SkillFull;
        console.log(color(`# ${skill.name}`, "1"));
        if (skill.description) console.log(`  ${skill.description}`);
        console.log(`  source:   ${skill.source}`);
        console.log(`  path:     ${skill.path}`);
        if (skill.references.length > 0) {
          console.log(`  refs:     ${skill.references.map((r) => r.name).join(", ")}`);
        }
        console.log();
        console.log(skill.content);
      }
    });

  cmd
    .command("create <name>")
    .description("Create a new user skill")
    .option("-c, --content <content>", "SKILL.md content (or pipe via stdin)")
    .option("-f, --file <path>", "Read content from file")
    .action(async (name: string, opts) => {
      let content: string;
      if (opts.file) {
        content = readFileSync(opts.file, "utf-8");
      } else if (opts.content) {
        content = opts.content;
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        content = Buffer.concat(chunks).toString("utf-8");
      }

      if (!content.trim()) {
        return console.error(
          "Error: No content provided. Use --content, --file, or pipe via stdin.",
        );
      }

      const client = createOrcClient();
      const { data, error } = await client.skills.create({ name, content });
      if (error) return console.error("Error:", error);
      if (!data) return console.error("Failed to create skill.");
      if (isJson()) return jsonOut(data);
      console.log(`Created skill: ${data.name} at ${data.path}`);
    });

  return cmd;
}
