import { createOrcClient } from "@orc/sdk/client";
import { Command } from "commander";
import { dryRunMsg, isDryRun, isJson, jsonErr, jsonOut } from "../output.js";
import { resolveProject } from "./project.js";

async function resolveTaskId(
  client: ReturnType<typeof createOrcClient>,
  input: string,
): Promise<string | null> {
  if (input.length === 26) return input;
  const { data } = await client.tasks.list({ limit: 100 });
  const match = (data?.tasks ?? []).find((t) => t.id.endsWith(input) || t.id === input);
  if (!match) {
    console.error(`Task not found: ${input}`);
    return null;
  }
  return match.id;
}

export function taskCommand() {
  const cmd = new Command("task").description("Manage tasks");

  cmd
    .command("list")
    .description("List tasks")
    .option("-p, --project <name>", "Filter by project name")
    .option("--no-project", "Show all tasks across projects")
    .option("-s, --status <status>", "Filter by status")
    .option("-l, --limit <n>", "Max results", "20")
    .option("--flat", "Disable status grouping")
    .action(async (opts) => {
      const client = createOrcClient();

      // Resolve project (default to active project)
      const noProject = opts.project === false;
      const project = noProject
        ? null
        : await resolveProject(client, { project: opts.project, noProject });

      const { data, error } = await client.tasks.list({
        ...(project ? { project_id: project.id } : {}),
        status: opts.status,
        limit: Number(opts.limit),
      });
      if (error) {
        if (isJson()) return jsonErr(String(error));
        return console.error("Error:", error);
      }
      const tasks = data?.tasks ?? [];
      if (isJson()) return jsonOut({ tasks, project: project?.name ?? null });
      if (tasks.length === 0) return console.log("No tasks found.");

      // Build project name map for cross-project view
      const projectNames = new Map<string, string>();
      if (noProject) {
        const { data: projData } = await client.projects.list({ limit: 100 });
        for (const p of projData?.projects ?? []) {
          projectNames.set(p.id, p.name);
        }
      } else if (project) {
        console.log(color(project.name, "1")); // bold
        console.log();
      }

      const showProject = noProject;

      if (opts.status || opts.flat) {
        // Flat list
        for (const t of tasks) {
          const line = formatTask(t, showProject ? projectNames : undefined);
          console.log(line);
        }
      } else {
        // Group by status
        const statusOrder = ["review", "changes_requested", "doing", "blocked", "todo"];
        const groups = new Map<string, typeof tasks>();
        for (const t of tasks) {
          const list = groups.get(t.status) ?? [];
          list.push(t);
          groups.set(t.status, list);
        }

        for (const status of statusOrder) {
          const group = groups.get(status);
          if (!group || group.length === 0) continue;

          const header = `── ${status} (${group.length}) `;
          console.log(colorStatus(header.padEnd(50, "─"), status));
          for (const t of group) {
            console.log(formatTask(t, showProject ? projectNames : undefined));
          }
          console.log();
        }
      }
    });

  cmd
    .command("add <title>")
    .description("Create a new task")
    .option("-p, --project <name>", "Project name")
    .option("--no-project", "Create without project")
    .option("--priority <p>", "Priority (low/normal/high/critical)", "normal")
    .option("-b, --body <text>", "Task body")
    .action(async (title: string, opts) => {
      const client = createOrcClient();
      const noProject = opts.project === false;
      const project = noProject
        ? null
        : await resolveProject(client, { project: opts.project, noProject });
      const { data, error } = await client.tasks.create({
        title,
        body: opts.body,
        ...(project ? { project_id: project.id } : {}),
        priority: opts.priority,
      });
      if (error) {
        if (isJson()) return jsonErr(String(error));
        return console.error("Error:", error);
      }
      if (isJson()) return jsonOut(data);
      console.log(`Created: [${data?.id.slice(-6)}] ${data?.title}`);
    });

  cmd
    .command("done <id>")
    .description("Mark task as done (accepts full ULID or last-6 suffix)")
    .action(async (id: string) => {
      const client = createOrcClient();
      const full = await resolveTaskId(client, id);
      if (!full) return;
      const { data, error } = await client.tasks.update(full, { status: "done" });
      if (error) {
        if (isJson()) return jsonErr(String(error));
        return console.error("Error:", error);
      }
      if (isJson()) return jsonOut(data);
      console.log(`Done: [${data?.id.slice(-6)}] ${data?.title}`);
    });

  cmd
    .command("review <id>")
    .description("Submit task for review")
    .action(async (id: string) => {
      const client = createOrcClient();
      const full = await resolveTaskId(client, id);
      if (!full) return;
      const { data, error } = await client.tasks.update(full, { status: "review" });
      if (error) {
        if (isJson()) return jsonErr(String(error));
        return console.error("Error:", error);
      }
      if (isJson()) return jsonOut(data);
      console.log(`In review: [${data?.id.slice(-6)}] ${data?.title}`);
    });

  cmd
    .command("approve <id>")
    .description("Approve a task in review (HITL)")
    .option("-n, --note <text>", "Optional note to add")
    .action(async (id: string, opts) => {
      const client = createOrcClient();
      const full = await resolveTaskId(client, id);
      if (!full) return;
      const { data: task, error: getErr } = await client.tasks.get(full);
      if (getErr) {
        if (isJson()) return jsonErr(String(getErr));
        return console.error("Error:", getErr);
      }
      if (task?.status !== "review") {
        return console.error(`Task is not in review (current: ${task?.status})`);
      }
      const { data, error } = await client.tasks.update(full, { status: "done" });
      if (error) {
        if (isJson()) return jsonErr(String(error));
        return console.error("Error:", error);
      }
      if (opts.note) await client.tasks.addNote(full, opts.note, "human");
      if (isJson()) return jsonOut(data);
      console.log(`Approved: [${data?.id.slice(-6)}] ${data?.title}`);
    });

  cmd
    .command("reject <id>")
    .description("Reject a task in review, request changes (HITL)")
    .option("-r, --reason <text>", "Reason for rejection")
    .action(async (id: string, opts) => {
      const client = createOrcClient();
      const full = await resolveTaskId(client, id);
      if (!full) return;
      const { data: task, error: getErr } = await client.tasks.get(full);
      if (getErr) {
        if (isJson()) return jsonErr(String(getErr));
        return console.error("Error:", getErr);
      }
      if (task?.status !== "review") {
        return console.error(`Task is not in review (current: ${task?.status})`);
      }
      const { data, error } = await client.tasks.update(full, { status: "changes_requested" });
      if (error) {
        if (isJson()) return jsonErr(String(error));
        return console.error("Error:", error);
      }
      if (opts.reason) await client.tasks.addNote(full, opts.reason, "human");
      if (isJson()) return jsonOut(data);
      console.log(`Changes requested: [${data?.id.slice(-6)}] ${data?.title}`);
    });

  cmd
    .command("show <id>")
    .description("Show task details")
    .action(async (id: string) => {
      const client = createOrcClient();
      const full = await resolveTaskId(client, id);
      if (!full) return;
      const { data: task, error } = await client.tasks.get(full);
      if (error) {
        if (isJson()) return jsonErr(String(error));
        return console.error("Error:", error);
      }
      if (!task) return console.error("Task not found");

      // Early JSON return with links
      if (isJson()) {
        const { data: linkData } = await client.tasks.listLinks(full);
        const links = linkData?.links ?? [];
        return jsonOut({ ...task, links });
      }

      const label = (l: string, v: string | null | undefined) => {
        if (v != null) console.log(`  ${color(l.padEnd(14), "2")} ${v}`);
      };

      console.log();
      console.log(
        `  ${colorStatus(statusIcon(task.status), task.status)} ${color(task.title, "1")}`,
      );
      console.log();
      label("ID", task.id);
      label("Status", `${statusIcon(task.status)} ${task.status}`);
      label("Priority", `${priorityIcon(task.priority)} ${task.priority}`);
      label("Progress", `${task.progress}%`);
      label("Project", task.project_id ?? undefined);
      label("Tags", task.tags?.join(", ") ?? undefined);
      label("Due", task.due_at ?? undefined);
      label("Author", task.author);
      label("Claimed by", task.claimed_by ?? undefined);
      label("Created", task.created_at);
      label("Updated", task.updated_at);

      if (task.body) {
        console.log();
        console.log(`  ${color("Body", "2")}`);
        console.log(`  ${task.body}`);
      }

      // Show links if any
      const { data: linkData } = await client.tasks.listLinks(full);
      const links = linkData?.links ?? [];
      if (links.length > 0) {
        console.log();
        console.log(`  ${color("Links", "2")}`);
        for (const link of links) {
          const target = link.from_task_id === full ? link.to_task_id : link.from_task_id;
          console.log(`    ${link.link_type} → [${target.slice(-6)}]`);
        }
      }
      console.log();
    });

  cmd
    .command("update <id>")
    .description("Update a task")
    .option("--title <t>", "New title")
    .option("--body <text>", "New body")
    .option(
      "--status <s>",
      "New status (todo/doing/review/changes_requested/blocked/done/cancelled)",
    )
    .option("--priority <p>", "Priority (low/normal/high/critical)")
    .option("--progress <n>", "Progress (0-100)")
    .option("--tags <csv>", "Comma-separated tags")
    .option("-p, --project <name>", "Move to project")
    .option("--no-project", "Remove from project")
    .action(async (id: string, opts) => {
      const client = createOrcClient();
      const full = await resolveTaskId(client, id);
      if (!full) return;

      const updates: Record<string, unknown> = {};
      if (opts.title) updates.title = opts.title;
      if (opts.body) updates.body = opts.body;
      if (opts.status) updates.status = opts.status;
      if (opts.priority) updates.priority = opts.priority;
      if (opts.progress !== undefined && opts.progress !== true)
        updates.progress = Number(opts.progress);
      if (opts.tags) updates.tags = (opts.tags as string).split(",").map((t: string) => t.trim());

      // Handle project option
      const noProject = opts.project === false;
      if (noProject) {
        updates.project_id = null;
      } else if (typeof opts.project === "string") {
        const project = await resolveProject(client, { project: opts.project, noProject: false });
        if (project) updates.project_id = project.id;
      }

      if (Object.keys(updates).length === 0) {
        return console.error("No updates specified. Use --help to see options.");
      }

      if (isDryRun()) return dryRunMsg("update", `task [${full.slice(-6)}]`, updates);
      const { data, error } = await client.tasks.update(full, updates);
      if (error) {
        if (isJson()) return jsonErr(String(error));
        return console.error("Error:", error);
      }
      if (isJson()) return jsonOut(data);
      console.log(`Updated: [${data?.id.slice(-6)}] ${data?.title}`);
    });

  cmd
    .command("delete <id>")
    .description("Delete a task")
    .action(async (id: string) => {
      const client = createOrcClient();
      const full = await resolveTaskId(client, id);
      if (!full) return;
      if (isDryRun()) return dryRunMsg("delete", `task [${full.slice(-6)}]`);
      const { error } = await client.tasks.delete(full);
      if (error) {
        if (isJson()) return jsonErr(String(error));
        return console.error("Error:", error);
      }
      if (isJson()) return jsonOut({ deleted: full });
      console.log(`Deleted: [${full.slice(-6)}]`);
    });

  return cmd;
}

function color(text: string, code: string): string {
  return process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
}

const STATUS_COLORS: Record<string, string> = {
  review: "33",
  changes_requested: "33",
  doing: "36",
  blocked: "31",
  todo: "2",
  done: "32",
  cancelled: "2",
};

function colorStatus(text: string, status: string): string {
  return color(text, STATUS_COLORS[status] ?? "0");
}

function statusIcon(status: string): string {
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
  const icons: Record<string, string> = {
    low: "↓",
    normal: "→",
    high: "↑",
    critical: "‼",
  };
  return icons[priority] ?? " ";
}

function formatTask(
  t: { id: string; title: string; status: string; priority: string; project_id?: string | null },
  projectNames?: Map<string, string>,
): string {
  const si = statusIcon(t.status);
  const pi = priorityIcon(t.priority);
  const id = t.id.slice(-6);
  const title = t.title.length > 40 ? t.title.slice(0, 39) + "…" : t.title;
  let line = `  ${colorStatus(si, t.status)} ${pi} [${id}] ${title.padEnd(40)}`;
  if (projectNames && t.project_id) {
    line += `  ${color(projectNames.get(t.project_id) ?? t.project_id.slice(-6), "2")}`;
  }
  return line;
}
