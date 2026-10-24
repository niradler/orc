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
    .command("projects <name>")
    .description("Show or replace skill project assignments; no assignments means global")
    .option("--set <ids...>", "Replace assignments with these project IDs")
    .option("--global", "Clear assignments and make the skill global")
    .action(async (name: string, options: { set?: string[]; global?: boolean }) => {
      if (options.global && options.set) throw new Error("Use either --set or --global");
      const client = createOrcClient({ source: "cli" });
      const result =
        options.global || options.set
          ? await client.skills.setProjects(name, options.global ? [] : (options.set ?? []))
          : await client.skills.projects(name);
      if (result.error || !result.data) throw new Error(JSON.stringify(result.error));
      if (isJson()) return jsonOut(result.data);
      console.log(result.data.project_ids.length ? result.data.project_ids.join("\n") : "Global");
    });
  cmd
    .command("import <source>")
    .description("Discover or import public GitHub / skills.sh skills")
    .option("--list", "List skills without installing")
    .option("-s, --skill <names...>", "Import skills by name (all available skills if omitted)")
    .action(async (source: string, options: { list?: boolean; skill?: string[] }) => {
      const client = createOrcClient({ source: "cli" });
      const discovery = await client.skills.discover(source);
      if (discovery.error || !discovery.data) throw new Error(JSON.stringify(discovery.error));
      for (const issue of discovery.data.issues) console.error(`${issue.path}: ${issue.error}`);
      if (options.list) {
        if (isJson()) return jsonOut(discovery.data);
        for (const skill of discovery.data.skills)
          console.log(
            `${skill.name}${skill.installed ? " [installed]" : ""} - ${skill.description}`,
          );
        return;
      }
      if (
        options.skill?.some((name) => !discovery.data?.skills.some((skill) => skill.name === name))
      )
        throw new Error("Selected skill not found in repository");
      const selected = discovery.data.skills.filter(
        (skill) => !skill.installed && (!options.skill || options.skill.includes(skill.name)),
      );
      if (!selected.length)
        throw new Error("No new skills selected; use --list to inspect the source");
      const result = await client.skills.import({
        source,
        commit: discovery.data.commit,
        paths: selected.map((skill) => skill.path),
      });
      if (result.error || !result.data) throw new Error(JSON.stringify(result.error));
      if (isJson()) return jsonOut(result.data);
      for (const skill of result.data.skills) console.log(`Imported ${skill.name}`);
    });
  cmd
    .command("local [agent]")
    .description("List or import skills from local agents (~/.claude, ~/.codex, ~/.agents, ...)")
    .option("-s, --skill <names...>", "Import these skills from <agent>")
    .option("--all", "Import every new skill from <agent>")
    .action(async (agent: string | undefined, options: { skill?: string[]; all?: boolean }) => {
      const client = createOrcClient({ source: "cli" });
      const listing = await client.skills.localAgents();
      if (listing.error || !listing.data) throw new Error(JSON.stringify(listing.error));
      const agents = listing.data.agents.filter((entry) => !agent || entry.id === agent);
      if (agent && !agents.length) throw new Error(`No skills folder found for agent: ${agent}`);
      if (!options.skill && !options.all) {
        if (isJson()) return jsonOut({ agents });
        for (const entry of agents) {
          console.log(color(`${entry.label} (${entry.id}) ${entry.dir}`, "1"));
          for (const skill of entry.skills) {
            const shared = skill.also_in.length ? ` (also in ${skill.also_in.join(", ")})` : "";
            const detail = skill.error ?? skill.description;
            console.log(`  [${skill.status}] ${skill.name}${shared} - ${detail}`);
            if (skill.extra_fields.length)
              console.log(`      extra fields: ${skill.extra_fields.join(", ")}`);
          }
        }
        return;
      }
      if (!agent)
        throw new Error("Name the agent to import from, e.g. orc skill local claude --all");
      const skills = agents[0]?.skills ?? [];
      const missing = options.skill?.filter((name) => !skills.some((skill) => skill.name === name));
      if (missing?.length) throw new Error(`Not found in ${agent}: ${missing.join(", ")}`);
      const selected = options.all
        ? skills.filter((skill) => skill.status === "new")
        : skills.filter((skill) => options.skill?.includes(skill.name));
      if (!selected.length) throw new Error(`No new skills to import from ${agent}`);
      const result = await client.skills.importLocal(
        selected.map((skill) => ({ agent, name: skill.name })),
      );
      if (result.error || !result.data) throw new Error(JSON.stringify(result.error));
      if (isJson()) return jsonOut(result.data);
      for (const skill of result.data.imported) console.log(`Imported ${skill.name}`);
      for (const skip of result.data.skipped) console.log(`Skipped ${skip.name}: ${skip.reason}`);
    });
  cmd
    .command("history <name>")
    .description("Read audited instruction history")
    .option("--project-id <id>", "Project scope; omitted means global")
    .action(async (name: string, options: { projectId?: string }) => {
      const result = await createOrcClient({ source: "cli" }).skills.history(
        name,
        options.projectId ? { project_id: options.projectId } : { scope: "global" },
      );
      if (result.error || !result.data) throw new Error(JSON.stringify(result.error));
      if (isJson()) return jsonOut(result.data);
      for (const change of result.data.changes)
        console.log(`${change.id} ${change.action} ${change.author}: ${change.reason}`);
    });
  cmd
    .command("revert <name> <change-id>")
    .description("Restore instructions before an audited change")
    .requiredOption("--expected-change-id <id>", "Current mutation ID from history")
    .requiredOption("--reason <text>", "Reason for revert")
    .option("--project-id <id>", "Project scope; omitted means global")
    .action(
      async (
        name: string,
        changeId: string,
        options: { projectId?: string; expectedChangeId: string; reason: string },
      ) => {
        const result = await createOrcClient({ source: "cli" }).skills.revert(name, {
          project_id: options.projectId ?? null,
          change_id: changeId,
          expected_change_id: options.expectedChangeId,
          reason: options.reason,
        });
        if (result.error || !result.data) throw new Error(JSON.stringify(result.error));
        if (isJson()) return jsonOut(result.data);
        console.log(`Reverted ${name}; retained audit and history`);
      },
    );
  cmd
    .command("sync <name>")
    .description("Pull GitHub updates while preserving local edits")
    .action(async (name: string) => {
      const result = await createOrcClient({ source: "cli" }).skills.sync(name);
      if (result.error || !result.data) throw new Error(JSON.stringify(result.error));
      if (isJson()) return jsonOut(result.data);
      if (!result.data.applied)
        return console.log(
          `Conflicts: ${result.data.conflicts.join(", ")}. Review overrides in the Skills dashboard.`,
        );
      console.log(`Synced ${name}: ${result.data.changed.length} files updated`);
    });
  cmd
    .command("export <name> <directory>")
    .description("Export the original SKILL.md and every supporting file")
    .action(async (name: string, directory: string) => {
      const client = createOrcClient({ source: "cli" });
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
    .option("--project-id <id>", "Show this project's skills and global skills")
    .option("--limit <count>", "Page size (1-500)", "30")
    .option("--offset <count>", "Zero-based page offset", "0")
    .option("-q, --query <q>", "Keyword search")
    .option("--source <source>", "Filter by source (builtin|user)")
    .option("--reload", "Force cache rebuild")
    .action(async (opts) => {
      const client = createOrcClient({ source: "cli" });
      const { data, error } = await client.skills.list({
        q: opts.query,
        source: opts.source,
        reload: opts.reload,
        project_id: opts.projectId,
        limit: Number(opts.limit),
        offset: Number(opts.offset),
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
        const score = s.score === undefined ? "" : ` [score: ${s.score.toFixed(4)}]`;
        console.log(`  ${name.padEnd(32)}${src}${score}${desc}`);
      }
      console.log(
        `Showing ${skills.length} of ${data?.total ?? 0}; next_offset=${data?.next_offset ?? "null"}`,
      );
    });

  cmd
    .command("read <name>")
    .description("Read effective skill instructions")
    .option("--project-id <id>", "Project instruction scope; omitted means global")
    .option("--ref <path>", "Read a skill-relative file path (bare filenames read references/)")
    .action(async (name: string, opts) => {
      const client = createOrcClient({ source: "cli" });
      const { data, error } = await client.skills.read(name, opts.ref, opts.projectId);
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

      const client = createOrcClient({ source: "cli" });
      const files = opts.directory
        ? listSkillFiles(opts.directory).map((file) => ({
            path: file.name,
            ...encodeSkillFile(readFileSync(file.path)),
          }))
        : undefined;
      const { data, error } = await client.skills.create({
        name,
        content,
        files,
      });
      if (error) return console.error("Error:", error);
      if (!data) return console.error("Failed to create skill.");
      if (isJson()) return jsonOut(data);
      console.log(`Created skill: ${data.name} at ${data.path}`);
    });

  return cmd;
}
