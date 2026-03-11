import { createOrcClient } from "@orc/sdk/client";
import { Command } from "commander";

export function taskCommand() {
  const cmd = new Command("task").description("Manage tasks");

  cmd
    .command("list")
    .description("List tasks")
    .option("-p, --project <id>", "Filter by project ID")
    .option("-s, --status <status>", "Filter by status")
    .option("-l, --limit <n>", "Max results", "20")
    .action(async (opts) => {
      const client = createOrcClient();
      const { data, error } = await client.tasks.list({
        project_id: opts.project,
        status: opts.status,
        limit: Number(opts.limit),
      });
      if (error) return console.error("Error:", error);
      const tasks = data?.tasks ?? [];
      if (tasks.length === 0) return console.log("No tasks found.");
      for (const t of tasks) {
        const status = statusIcon(t.status);
        const priority = priorityIcon(t.priority);
        console.log(`${status} ${priority} [${t.id.slice(-6)}] ${t.title}`);
        if (t.project_id) console.log(`   project: ${t.project_id}`);
      }
    });

  cmd
    .command("add <title>")
    .description("Create a new task")
    .option("-p, --project <id>", "Project ID")
    .option("--priority <p>", "Priority (low/normal/high/critical)", "normal")
    .option("-b, --body <text>", "Task body")
    .action(async (title: string, opts) => {
      const client = createOrcClient();
      const { data, error } = await client.tasks.create({
        title,
        body: opts.body,
        project_id: opts.project,
        priority: opts.priority,
      });
      if (error) return console.error("Error:", error);
      console.log(`Created: [${data!.id.slice(-6)}] ${data!.title}`);
    });

  cmd
    .command("done <id>")
    .description("Mark task as done")
    .action(async (id: string) => {
      const client = createOrcClient();
      const { data, error } = await client.tasks.update(id, { status: "done" });
      if (error) return console.error("Error:", error);
      console.log(`Done: [${data!.id.slice(-6)}] ${data!.title}`);
    });

  cmd
    .command("review <id>")
    .description("Submit task for review")
    .action(async (id: string) => {
      const client = createOrcClient();
      const { data, error } = await client.tasks.update(id, { status: "review" });
      if (error) return console.error("Error:", error);
      console.log(`In review: [${data!.id.slice(-6)}] ${data!.title}`);
    });

  cmd
    .command("approve <id>")
    .description("Approve a task in review (HITL)")
    .option("-n, --note <text>", "Optional note to add")
    .action(async (id: string, opts) => {
      const client = createOrcClient();
      const { data: task, error: getErr } = await client.tasks.get(id);
      if (getErr) return console.error("Error:", getErr);
      if (task!.status !== "review") {
        return console.error(`Task is not in review (current: ${task!.status})`);
      }
      const { data, error } = await client.tasks.update(id, { status: "done" });
      if (error) return console.error("Error:", error);
      if (opts.note) {
        await client.tasks.addNote(id, opts.note, "human");
      }
      console.log(`Approved: [${data!.id.slice(-6)}] ${data!.title}`);
    });

  cmd
    .command("reject <id>")
    .description("Reject a task in review, request changes (HITL)")
    .option("-r, --reason <text>", "Reason for rejection")
    .action(async (id: string, opts) => {
      const client = createOrcClient();
      const { data: task, error: getErr } = await client.tasks.get(id);
      if (getErr) return console.error("Error:", getErr);
      if (task!.status !== "review") {
        return console.error(`Task is not in review (current: ${task!.status})`);
      }
      const { data, error } = await client.tasks.update(id, { status: "changes_requested" });
      if (error) return console.error("Error:", error);
      if (opts.reason) {
        await client.tasks.addNote(id, opts.reason, "human");
      }
      console.log(`Changes requested: [${data!.id.slice(-6)}] ${data!.title}`);
    });

  return cmd;
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
