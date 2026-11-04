import { shortId } from "@orc/core/ids";
import { JobActionSchema } from "@orc/core/job-actions";
import { createOrcClient } from "@orc/sdk/client";
import type { Job } from "@orc/sdk/types";
import { Command } from "commander";
import { isJson, jsonOut } from "../output.js";
import { resolveProject } from "./project.js";

type OrcClient = ReturnType<typeof createOrcClient>;

export async function listAllJobs(
  client: OrcClient,
  params: { project_id?: string } = {},
): Promise<{ jobs: Job[]; error: unknown }> {
  const jobs: Job[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const { data, error } = await client.jobs.list({ ...params, limit: 100, offset });
    if (error || !data) return { jobs, error: error ?? "Empty response" };
    jobs.push(...data.jobs);
    offset = data.next_offset;
  }
  return { jobs, error: null };
}

async function findJob(client: OrcClient, nameOrId: string): Promise<Job | null> {
  const byId = await client.jobs.get(nameOrId);
  if (byId.data) return byId.data;
  const { jobs, error } = await listAllJobs(client);
  if (error) {
    console.error("Error:", error);
    process.exitCode = 1;
    return null;
  }
  const job = jobs.find((j) => j.name === nameOrId);
  if (!job) {
    console.error(`Job not found: ${nameOrId}`);
    process.exitCode = 1;
  }
  return job ?? null;
}

export function jobCommand() {
  const cmd = new Command("job").description("Manage jobs");

  cmd
    .command("list")
    .description("List jobs")
    .option("-p, --project <name>", "Filter by project name")
    .option("--no-project", "Show all jobs")
    .action(async (opts) => {
      const client = createOrcClient();
      const noProject = opts.project === false;
      const project = noProject
        ? null
        : await resolveProject(client, { project: opts.project, noProject });
      const { jobs: rows, error } = await listAllJobs(
        client,
        project ? { project_id: project.id } : {},
      );
      if (error) return console.error("Error:", error);
      if (isJson()) return jsonOut({ jobs: rows });
      if (rows.length === 0) return console.log("No jobs found.");
      for (const j of rows) {
        const en = j.enabled ? "●" : "○";
        const trigger = j.cron_expr ? `cron(${j.cron_expr})` : j.trigger_type;
        console.log(`${en} ${j.name.padEnd(24)} ${trigger.padEnd(20)} runs:${j.run_count}`);
      }
    });

  cmd
    .command("add <name>")
    .description("Create a job")
    .option("--enable", "Enable the job immediately (new jobs are disabled by default)", false)
    .option("-c, --command <cmd>", "Shell command to run")
    .option("--action-config <json>", "Typed action JSON: command, agent or task")
    .option("--trigger <type>", "Trigger type (manual/cron/watch/one-shot/webhook)", "manual")
    .option("--cron <expr>", "Cron expression (e.g. '0 22 * * *' or '*/30 * * * * *' every 30s)")
    .option("--watch <path>", "Watch path for file changes")
    .option("--timeout <secs>", "Timeout in seconds", "300")
    .option("--retries <n>", "Max retries", "0")
    .option("--notify <when>", "Notify on: never/failure/always", "failure")
    .option("-d, --description <text>", "Description")
    .option("-p, --project <name>", "Project name")
    .option("--no-project", "Create without project")
    .action(async (name: string, opts) => {
      const client = createOrcClient();
      const noProject = opts.project === false;
      const project = noProject
        ? null
        : await resolveProject(client, { project: opts.project, noProject });
      const { data, error } = await client.jobs.create({
        name,
        enabled: opts.enable,
        ...(project ? { project_id: project.id } : {}),
        description: opts.description,
        ...(opts.actionConfig
          ? { action: JobActionSchema.parse(JSON.parse(opts.actionConfig)) }
          : { command: opts.command }),
        trigger_type: opts.trigger as
          | "manual"
          | "cron"
          | "watch"
          | "webhook"
          | "one-shot"
          | "bridge-msg",
        cron_expr: opts.cron,
        watch_path: opts.watch,
        timeout_secs: Number(opts.timeout),
        max_retries: Number(opts.retries),
        notify_on: opts.notify as "never" | "failure" | "always",
      });
      if (error || !data) return console.error("Error:", error);
      if (isJson()) return jsonOut(data);
      console.log(`Created job: ${data.name} [${shortId(data.id)}]`);
    });

  cmd
    .command("run <name-or-id>")
    .description("Manually trigger a job")
    .option("-w, --wait", "Wait for the run and print its output (JSON stdout as result)")
    .option("--wait-secs <secs>", "Longest wait with --wait, 1-240", "240")
    .action(async (nameOrId: string, opts: { wait?: boolean; waitSecs: string }) => {
      const client = createOrcClient();
      const job = await findJob(client, nameOrId);
      if (!job) return;

      if (!opts.wait) {
        const { data, error } = await client.jobs.trigger(job.id);
        if (error || !data) return console.error("Error:", error);
        if (isJson()) return jsonOut(data);
        return console.log(`Triggered job ${job.name} → run: ${data.run_id}`);
      }
      const { data, error } = await client.jobs.triggerSync(job.id, Number(opts.waitSecs));
      if (error || !data) {
        process.exitCode = 1;
        return console.error("Error:", error);
      }
      const finished = "result" in data;
      if (!finished || data.status !== "success") process.exitCode = 1;
      if (isJson()) return jsonOut(data);
      if (!finished)
        return console.error(
          `Job ${job.name} is still ${data.status} → run: ${data.run_id} (see orc job show)`,
        );
      if (data.stdout) console.log(data.stdout);
      if (data.stderr) console.error(data.stderr);
      if (data.status !== "success")
        console.error(
          `Job ${job.name} ${data.status} (exit ${data.exit_code ?? "?"})${data.error_msg ? `: ${data.error_msg}` : ""}`,
        );
    });

  cmd
    .command("show <name-or-id>")
    .description("Show job details")
    .action(async (nameOrId: string) => {
      const client = createOrcClient();
      const job = await findJob(client, nameOrId);
      if (!job) return;

      const { data, error } = await client.jobs.get(job.id);
      if (error || !data) return console.error("Error:", error);
      if (isJson()) return jsonOut(data);

      const fields: [string, unknown][] = [
        ["Name", data.name],
        ["ID", data.id],
        ["Description", data.description],
        ["Command", data.command],
        ["Trigger", data.trigger_type],
        ["Cron", data.cron_expr],
        ["Enabled", data.enabled],
        ["Timeout (s)", data.timeout_secs],
        ["Max retries", data.max_retries],
        ["Overlap", data.overlap],
        ["Notify on", data.notify_on],
        ["Project ID", data.project_id],
        ["Run count", data.run_count],
        ["Last run", data.last_run_at],
        ["Created", data.created_at],
        ["Updated", data.updated_at],
      ];

      for (const [label, value] of fields) {
        if (value !== undefined && value !== null && value !== "")
          console.log(`${label.padEnd(14)} ${value}`);
      }
    });

  cmd
    .command("delete <name-or-id>")
    .description("Delete a job")
    .action(async (nameOrId: string) => {
      const client = createOrcClient();
      const job = await findJob(client, nameOrId);
      if (!job) return;

      const { error } = await client.jobs.delete(job.id);
      if (error) return console.error("Error:", error);
      if (isJson()) return jsonOut({ deleted: job.id, name: job.name });
      console.log(`Deleted job: ${job.name} [${shortId(job.id)}]`);
    });

  cmd
    .command("update <name-or-id>")
    .description("Update a job")
    .option("--name <n>", "New name")
    .option("-d, --description <text>", "Description")
    .option("-c, --command <cmd>", "Shell command")
    .option("--trigger <type>", "Trigger type")
    .option("--cron <expr>", "Cron expression")
    .option("--timeout <secs>", "Timeout in seconds")
    .option("--retries <n>", "Max retries")
    .option("--notify <when>", "Notify on: never/failure/always")
    .option("--enabled", "Enable the job")
    .option("--disabled", "Disable the job")
    .action(async (nameOrId: string, opts) => {
      const client = createOrcClient();
      const job = await findJob(client, nameOrId);
      if (!job) return;

      const input: Record<string, unknown> = {};
      if (opts.name) input.name = opts.name;
      if (opts.description) input.description = opts.description;
      if (opts.command) input.command = opts.command;
      if (opts.trigger) input.trigger_type = opts.trigger;
      if (opts.cron) input.cron_expr = opts.cron;
      if (opts.timeout) input.timeout_secs = Number(opts.timeout);
      if (opts.retries) input.max_retries = Number(opts.retries);
      if (opts.notify) input.notify_on = opts.notify;
      if (opts.enabled) input.enabled = true;
      if (opts.disabled) input.enabled = false;

      const { data, error } = await client.jobs.update(job.id, input as never);
      if (error || !data) return console.error("Error:", error);
      if (isJson()) return jsonOut(data);
      console.log(`Updated job: ${data.name} [${shortId(data.id)}]`);
    });

  cmd
    .command("runs <name-or-id>")
    .description("Show recent runs for a job")
    .option("-l, --limit <n>", "Max results", "10")
    .option("-s, --sessions", "Show linked agent sessions per run")
    .option("--logs", "Show stdout/stderr logs for each run")
    .action(async (nameOrId: string, opts) => {
      const client = createOrcClient();
      const job = await findJob(client, nameOrId);
      if (!job) return;

      const { data, error } = await client.jobs.runs(job.id, Number(opts.limit));
      if (error) return console.error("Error:", error);
      const runs = data?.runs ?? [];
      if (isJson()) return jsonOut({ runs });
      if (runs.length === 0) return console.log("No runs yet.");

      for (const r of runs) {
        const icon = runIcon(r.status);
        const dur =
          r.started_at && r.ended_at
            ? `${Math.round((new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 1000)}s`
            : "-";
        console.log(
          `${icon} ${r.status.padEnd(10)} ${r.created_at.slice(0, 19)}  ${dur}  [${shortId(r.id)}]`,
        );

        if (opts.logs) {
          const { data: logData } = await client.jobs.runLogs(job.id, r.id);
          for (const entry of logData?.logs ?? []) {
            const prefix = entry.stream === "stderr" ? "  ERR" : "  OUT";
            console.log(`${prefix} ${entry.line}`);
          }
        }

        if (opts.sessions) {
          const { data: sessData } = await client.sessions.list({
            job_run_id: r.id,
            limit: 5,
          });
          for (const s of sessData?.sessions ?? []) {
            const summary = s.summary ? `  ${s.summary.split("\n")[0]?.slice(0, 60)}` : "";
            console.log(
              `    ↳ session ${s.agent}${s.agent_version ? `/${s.agent_version}` : ""}${summary}`,
            );
          }
        }
      }
    });

  return cmd;
}

function runIcon(status: string): string {
  const icons: Record<string, string> = {
    pending: "○",
    running: "◐",
    success: "●",
    failed: "✕",
    cancelled: "⊘",
    skipped: "↷",
  };
  return icons[status] ?? "?";
}
