import { createOrcClient } from "@orc/sdk/client";
import { Command } from "commander";

export function jobCommand() {
  const cmd = new Command("job").description("Manage jobs");

  cmd
    .command("list")
    .description("List jobs")
    .action(async () => {
      const client = createOrcClient();
      const { data, error } = await client.jobs.list();
      if (error) return console.error("Error:", error);
      const rows = data?.jobs ?? [];
      if (rows.length === 0) return console.log("No jobs defined.");
      for (const j of rows) {
        const en = j.enabled ? "●" : "○";
        const trigger = j.cron_expr ? `cron(${j.cron_expr})` : j.trigger_type;
        console.log(`${en} ${j.name.padEnd(24)} ${trigger.padEnd(20)} runs:${j.run_count}`);
      }
    });

  cmd
    .command("add <name>")
    .description("Create a job")
    .requiredOption("-c, --command <cmd>", "Shell command to run")
    .option("--trigger <type>", "Trigger type (manual/cron/watch/one-shot/webhook)", "manual")
    .option("--cron <expr>", "Cron expression (e.g. '0 22 * * *' or '*/30 * * * * *' every 30s)")
    .option("--watch <path>", "Watch path for file changes")
    .option("--timeout <secs>", "Timeout in seconds", "300")
    .option("--retries <n>", "Max retries", "0")
    .option("--notify <when>", "Notify on: never/failure/always", "failure")
    .option("-d, --description <text>", "Description")
    .action(async (name: string, opts) => {
      const client = createOrcClient();
      const { data, error } = await client.jobs.create({
        name,
        description: opts.description,
        command: opts.command,
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
      console.log(`Created job: ${data.name} [${data.id.slice(-6)}]`);
    });

  cmd
    .command("run <name-or-id>")
    .description("Manually trigger a job")
    .action(async (nameOrId: string) => {
      const client = createOrcClient();
      const { data: list, error: listErr } = await client.jobs.list();
      if (listErr) return console.error("Error:", listErr);
      const job = list?.jobs.find((j) => j.name === nameOrId || j.id === nameOrId);
      if (!job) return console.error(`Job not found: ${nameOrId}`);

      const { data, error } = await client.jobs.trigger(job.id);
      if (error || !data) return console.error("Error:", error);
      console.log(`Triggered job ${job.name} → run: ${data.run_id}`);
    });

  cmd
    .command("runs <name-or-id>")
    .description("Show recent runs for a job")
    .option("-l, --limit <n>", "Max results", "10")
    .option("-s, --sessions", "Show linked agent sessions per run")
    .option("--logs", "Show stdout/stderr logs for each run")
    .action(async (nameOrId: string, opts) => {
      const client = createOrcClient();
      const { data: list, error: listErr } = await client.jobs.list();
      if (listErr) return console.error("Error:", listErr);
      const job = list?.jobs.find((j) => j.name === nameOrId || j.id === nameOrId);
      if (!job) return console.error(`Job not found: ${nameOrId}`);

      const { data, error } = await client.jobs.runs(job.id, Number(opts.limit));
      if (error) return console.error("Error:", error);
      const runs = data?.runs ?? [];
      if (runs.length === 0) return console.log("No runs yet.");

      for (const r of runs) {
        const icon = runIcon(r.status);
        const dur =
          r.started_at && r.ended_at
            ? `${Math.round((new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 1000)}s`
            : "-";
        console.log(
          `${icon} ${r.status.padEnd(10)} ${r.created_at.slice(0, 19)}  ${dur}  [${r.id.slice(-6)}]`,
        );

        if (opts.logs) {
          const { data: logData } = await client.jobs.runLogs(job.id, r.id);
          for (const entry of logData?.logs ?? []) {
            const prefix = entry.stream === "stderr" ? "  ERR" : "  OUT";
            console.log(`${prefix} ${entry.line}`);
          }
        }

        if (opts.sessions) {
          const { data: sessData } = await client.sessions.list({ job_run_id: r.id, limit: 5 });
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
