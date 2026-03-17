import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@orc/core/config";
import { createOrcClient } from "@orc/sdk/client";
import { Command } from "commander";
import { dryRunMsg, isDryRun, isJson, jsonErr, jsonOut } from "../output.js";

export async function resolveProject(
  client: ReturnType<typeof createOrcClient>,
  opts: { project?: string; noProject?: boolean },
): Promise<{ id: string; name: string } | null> {
  if (opts.noProject) return null;

  const name = opts.project ?? loadConfig().activeProject;
  if (!name) {
    console.error("No project set. Use -p <name> or 'orc project use <name>'");
    process.exit(1);
  }

  const { data, error } = await client.projects.getByName(name);
  if (error || !data) {
    console.error(`Project not found: ${name}`);
    process.exit(1);
  }
  return { id: data.id, name: data.name };
}

function statusIcon(status: string): string {
  const icons: Record<string, string> = { active: "●", paused: "◐", archived: "○" };
  return icons[status] ?? "?";
}

function formatAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function taskStatusIcon(status: string): string {
  const icons: Record<string, string> = {
    todo: "○",
    doing: "◐",
    review: "◉",
    changes_requested: "↩",
    blocked: "⊘",
    done: "●",
    cancelled: "✕",
  };
  return icons[status] ?? "?";
}

function priorityIcon(priority: string): string {
  const icons: Record<string, string> = { low: "↓", normal: "→", high: "↑", critical: "‼" };
  return icons[priority] ?? " ";
}

function configPath(): string {
  return join(homedir(), ".orc", "config.json");
}

function readConfigFile(): Record<string, unknown> {
  const p = configPath();
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf-8"));
}

function writeConfigFile(cfg: Record<string, unknown>): void {
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n");
}

export function projectCommand() {
  const cmd = new Command("project").description("Manage projects");

  cmd
    .command("list")
    .description("List projects")
    .option("--status <s>", "Filter by status")
    .option("-l, --limit <n>", "Max results", "20")
    .action(async (opts) => {
      const client = createOrcClient();
      const { data, error } = await client.projects.list({
        status: opts.status,
        limit: Number(opts.limit),
      });
      if (error) return console.error("Error:", error);
      const projects = data?.projects ?? [];
      if (isJson()) return jsonOut({ projects });
      if (projects.length === 0) return console.log("No projects found.");

      for (const p of projects) {
        const { data: summary } = await client.projects.summary(p.id);
        const icon = statusIcon(p.status);
        let line = `${icon} ${p.name.padEnd(18)} (${p.status})`;
        if (summary) {
          const taskTotal = summary.tasks.total;
          const reviewCount = summary.tasks.by_status.review ?? 0;
          const taskPart =
            reviewCount > 0 ? `${taskTotal} tasks (${reviewCount} review)` : `${taskTotal} tasks`;
          line += `  ${taskPart}  ${summary.memories} mems  ${summary.jobs} jobs`;
        }
        console.log(line);
      }
    });

  cmd
    .command("add <name>")
    .description("Create a new project")
    .option("-d, --description <text>", "Project description")
    .option("--scope <s>", "Project scope")
    .option("--tags <csv>", "Comma-separated tags")
    .action(async (name: string, opts) => {
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        return console.error("Invalid project name: only [a-zA-Z0-9_-] characters allowed.");
      }

      const client = createOrcClient();
      const tags = opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : undefined;
      const { data, error } = await client.projects.create({
        name,
        description: opts.description,
        scope: opts.scope,
        tags,
      });
      if (error) return console.error("Error:", error);
      if (isJson()) return jsonOut(data);

      const config = loadConfig();
      if (!config.activeProject) {
        const cfg = readConfigFile();
        cfg.activeProject = name;
        writeConfigFile(cfg);
      }

      console.log(`Created: ${data?.name} [${data?.id.slice(-6)}]`);
    });

  cmd
    .command("show [name]")
    .description("Show project details")
    .action(async (name?: string) => {
      const client = createOrcClient();
      const projectName = name ?? loadConfig().activeProject;
      if (!projectName) {
        return console.error("No project set. Use -p <name> or 'orc project use <name>'");
      }

      const { data: project, error } = await client.projects.getByName(projectName);
      if (error || !project) return console.error(`Project not found: ${projectName}`);

      const [summaryRes, tasksRes, jobsRes, memoriesRes] = await Promise.all([
        client.projects.summary(project.id),
        client.tasks.list({ project_id: project.id }),
        client.jobs.list({ project_id: project.id }),
        client.memories.list({ project_id: project.id }),
      ]);

      const summary = summaryRes.data;
      const tasks = tasksRes.data?.tasks ?? [];
      const jobs = jobsRes.data?.jobs ?? [];
      const memories = memoriesRes.data?.memories ?? [];

      if (isJson()) return jsonOut({ project, summary: summary ?? null, tasks, jobs, memories });

      console.log(`${project.name} (${project.status})`);
      if (project.description) console.log(`  ${project.description}`);
      console.log();

      if (summary) {
        const byStatus = summary.tasks.by_status;
        const parts = Object.entries(byStatus)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `${k}: ${v}`);
        console.log(`Tasks (${summary.tasks.total})`);
        if (parts.length > 0) console.log(`  ${parts.join("  ")}`);
        console.log();
      }

      for (const t of tasks.slice(0, 10)) {
        const si = taskStatusIcon(t.status);
        const pi = priorityIcon(t.priority);
        console.log(`  ${si} ${pi} [${t.id.slice(-6)}] ${t.title.padEnd(36)} ${t.status}`);
      }
      if (tasks.length > 10) console.log(`  ... and ${tasks.length - 10} more`);
      console.log();

      console.log(`Jobs (${jobs.length})`);
      for (const j of jobs) {
        const trigger =
          j.trigger_type === "cron" && j.cron_expr ? `cron(${j.cron_expr})` : j.trigger_type;
        console.log(`  ● ${j.name.padEnd(20)} ${trigger}   runs:${j.run_count}`);
      }
      console.log();

      const totalMemories = summary?.memories ?? memories.length;
      const shown = memories.slice(0, 5);
      console.log(`Memories (${shown.length} of ${totalMemories})`);
      for (const m of shown) {
        const scope = m.scope ? `[${m.scope}]` : "";
        const age = formatAge(m.created_at);
        console.log(`  • ${scope} ${m.content.slice(0, 50).padEnd(50)} ${age}`);
      }
    });

  cmd
    .command("use <name>")
    .description("Set active project")
    .option("--clear", "Unset active project")
    .action(async (name: string, opts) => {
      const cfg = readConfigFile();

      if (opts.clear) {
        delete cfg.activeProject;
        writeConfigFile(cfg);
        return console.log("Active project cleared");
      }

      const client = createOrcClient();
      const { data, error } = await client.projects.getByName(name);
      if (error || !data) return console.error(`Project not found: ${name}`);

      cfg.activeProject = name;
      writeConfigFile(cfg);
      if (isJson()) return jsonOut({ activeProject: name });
      console.log(`Active project: ${name}`);
    });

  cmd
    .command("update <name>")
    .description("Update a project")
    .option("--name <n>", "New name")
    .option("-d, --description <text>", "Description")
    .option("--status <s>", "Status (active/paused/archived)")
    .option("--scope <s>", "Scope")
    .option("--tags <csv>", "Comma-separated tags")
    .action(async (name: string, opts) => {
      const client = createOrcClient();
      const { data: project, error: findErr } = await client.projects.getByName(name);
      if (findErr || !project) return console.error(`Project not found: ${name}`);

      if (isDryRun()) return dryRunMsg("update", `project ${name}`);
      const tags = opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : undefined;
      const { data, error } = await client.projects.update(project.id, {
        name: opts.name,
        description: opts.description,
        status: opts.status,
        scope: opts.scope,
        tags,
      });
      if (error) return console.error("Error:", error);
      if (isJson()) return jsonOut(data);
      console.log(`Updated: ${data?.name} [${data?.id.slice(-6)}]`);
    });

  cmd
    .command("archive <name>")
    .description("Archive a project")
    .action(async (name: string) => {
      const client = createOrcClient();
      const { data: project, error: findErr } = await client.projects.getByName(name);
      if (findErr || !project) return console.error(`Project not found: ${name}`);

      if (isDryRun()) return dryRunMsg("archive", `project ${name}`);
      const { data, error } = await client.projects.update(project.id, { status: "archived" });
      if (error) return console.error("Error:", error);
      if (isJson()) return jsonOut(data);
      console.log(`Archived: ${data?.name} [${data?.id.slice(-6)}]`);
    });

  cmd
    .command("delete <name>")
    .description("Delete a project")
    .action(async (name: string) => {
      const client = createOrcClient();
      const { data: project, error: findErr } = await client.projects.getByName(name);
      if (findErr || !project) return console.error(`Project not found: ${name}`);

      if (isDryRun()) return dryRunMsg("delete", `project ${name}`);
      const { error } = await client.projects.delete(project.id);
      if (error) return console.error("Error:", error);
      if (isJson()) return jsonOut({ deleted: project.id, name });
      console.log(`Deleted project: ${name} [${project.id.slice(-6)}]`);
    });

  return cmd;
}
