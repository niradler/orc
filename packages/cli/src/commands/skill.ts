import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { encodeSkillFile, listSkillFiles, validateSkillPath } from "@orc/core/skill-files";
import { parseFrontmatter } from "@orc/core/skill-service";
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
    .command("export <name> <directory>")
    .description("Export the original SKILL.md and every supporting file")
    .action(async (name: string, directory: string) => {
      const client = createOrcClient();
      const result = await client.skills.read(name);
      if (result.error || !result.data) throw new Error(JSON.stringify(result.error));
      const skill = result.data as SkillFull;
      const files = await Promise.all(
        ["SKILL.md", ...skill.files.map((file) => file.name)].map(async (path) => {
          validateSkillPath(path);
          const file = await client.skills.read(name, path);
          if (file.error || !file.data) throw new Error(JSON.stringify(file.error));
          return { path, data: file.data as SkillRefContent };
        }),
      );
      const root = resolve(directory);
      if (existsSync(root))
        throw new Error("Export destination already exists; choose a new directory");
      mkdirSync(root, { recursive: true });
      for (const file of files) {
        const path = join(root, file.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, Buffer.from(file.data.content, file.data.encoding), { flag: "wx" });
      }
      console.log(`Exported ${name} to ${root}`);
    });
  cmd
    .command("validate <directory>")
    .description("Validate a folder against the Agent Skills specification")
    .action((directory: string) => {
      const content = readFileSync(join(directory, "SKILL.md"), "utf8");
      const { frontmatter } = parseFrontmatter(content);
      const name = directory
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .at(-1);
      if (frontmatter.name !== name)
        throw new Error("Skill directory name must match frontmatter name");
      const files = listSkillFiles(directory);
      console.log(`Valid Agent Skill: ${frontmatter.name}; ${files.length} supporting files`);
    });

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
      if (isJson()) return jsonOut(data);
      for (const issue of data?.broken ?? []) console.error(`${issue.path}: ${issue.error}`);
      for (const w of data?.warnings ?? []) console.error(`warning: ${w.path}: ${w.message}`);
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
    .option("--ref <path>", "Read a skill-relative file path (bare filenames read references/)")
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
        if (ref.encoding === "base64") console.log("Encoding: base64");
        console.log(ref.content);
      } else {
        const skill = data as SkillFull;
        console.log(color(`# ${skill.name}`, "1"));
        if (skill.description) console.log(`  ${skill.description}`);
        console.log(`  source:   ${skill.source}`);
        console.log(`  path:     ${skill.path}`);
        if (skill.files.length > 0) {
          console.log(`  files:    ${skill.files.map((r) => r.name).join(", ")}`);
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
    .option(
      "-d, --directory <path>",
      "Import a skill folder including SKILL.md and supporting files",
    )
    .action(async (name: string, opts) => {
      let content: string;
      if (opts.directory) {
        content = readFileSync(join(opts.directory, "SKILL.md"), "utf-8");
      } else if (opts.file) {
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
      const files = opts.directory
        ? listSkillFiles(opts.directory).map((file) => ({
            path: file.name,
            ...encodeSkillFile(readFileSync(file.path)),
          }))
        : undefined;
      const { data, error } = await client.skills.create({ name, content, files });
      if (error) return console.error("Error:", error);
      if (!data) return console.error("Failed to create skill.");
      if (isJson()) return jsonOut(data);
      console.log(`Created skill: ${data.name} at ${data.path}`);
    });

  return cmd;
}
