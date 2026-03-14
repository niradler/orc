import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@orc/core/config";
import { startGateway, stopGateway } from "@orc/gateway";
import { startScheduler, startWatchers, stopScheduler, stopWatchers } from "@orc/runner";
import { createOrcClient } from "@orc/sdk/client";
import { Command } from "commander";

export const ORC_HOME = process.env.ORC_HOME ?? join(homedir(), ".orc");
export const ORC_LOG = join(ORC_HOME, "daemon.log");
export const ORC_PID = join(ORC_HOME, "daemon.pid");

function ensureOrcHome() {
  mkdirSync(join(ORC_HOME, "logs"), { recursive: true });
}

export function readDaemonPid(): number | null {
  try {
    return Number(readFileSync(ORC_PID, "utf-8").trim());
  } catch {
    return null;
  }
}

function writePid() {
  writeFileSync(ORC_PID, String(process.pid));
}

function removePid() {
  try {
    require("node:fs").unlinkSync(ORC_PID);
  } catch {}
}

export function daemonCommand() {
  const cmd = new Command("daemon").description(
    "Run the API + scheduler + file watchers + gateway as one persistent process",
  );

  cmd
    .command("start", { isDefault: true })
    .description("Start the daemon (use global --port / --host / --db / --secret to configure)")
    .action(async () => {
      ensureOrcHome();

      const existingPid = readDaemonPid();
      if (existingPid) {
        try {
          process.kill(existingPid, 0);
          console.error(`[orc] daemon already running (pid ${existingPid}). Use: orc daemon stop`);
          process.exit(1);
        } catch {
          // stale pid
        }
      }

      const config = loadConfig();

      writePid();
      await import("@orc/api");
      console.log(`[orc] home     ${ORC_HOME}`);
      console.log(`[orc] db       ${config.db.path}`);
      console.log(`[orc] API      http://${config.api.host}:${config.api.port}`);
      console.log(`[orc] pid      ${process.pid} -> ${ORC_PID}`);

      await startScheduler();
      await startWatchers();
      await startGateway();
      console.log("[orc] Scheduler + watchers + gateway active. Ctrl+C to stop.\n");

      const shutdown = async (signal: string) => {
        process.stdout.write(`\n[orc] ${signal} - shutting down...\n`);
        stopScheduler();
        await stopWatchers();
        await stopGateway();
        removePid();
        process.stdout.write("[orc] Stopped.\n");
        process.exit(0);
      };

      process.on("SIGINT", () => void shutdown("SIGINT"));
      process.on("SIGTERM", () => void shutdown("SIGTERM"));

      await new Promise(() => {});
    });

  cmd
    .command("stop")
    .description("Stop the running daemon")
    .action(() => {
      const daemonPid = readDaemonPid();
      if (!daemonPid) {
        console.log("No daemon running (no pid file at ~/.orc/daemon.pid).");
        return;
      }
      try {
        process.kill(daemonPid, "SIGTERM");
        console.log(`Sent SIGTERM to daemon (pid ${daemonPid}).`);
      } catch {
        console.error(`Could not signal pid ${daemonPid} - process may already be stopped.`);
        removePid();
      }
    });

  cmd
    .command("status")
    .description("Show scheduler state and next run times for all active jobs")
    .action(async () => {
      const client = createOrcClient();
      const { data, error } = await client.jobs.list();
      if (error) return console.error("Error:", error);

      const scheduled = (data?.jobs ?? []).filter(
        (j) => j.enabled && (j.trigger_type === "cron" || j.trigger_type === "watch"),
      );

      if (scheduled.length === 0) {
        console.log("No scheduled jobs defined.");
        console.log("Create one with: orc job add <name> --trigger cron --cron '0 22 * * *' ...");
        return;
      }

      console.log("Scheduled jobs:\n");
      for (const j of scheduled) {
        const trigger = j.trigger_type === "cron" ? `cron(${j.cron_expr ?? "?"})` : j.trigger_type;
        const lastRun = j.last_run_at
          ? new Date(j.last_run_at).toISOString().slice(0, 19)
          : "never";
        const runs = `runs:${j.run_count}`;
        const enabled = j.enabled ? "●" : "○";
        console.log(
          `  ${enabled} ${j.name.padEnd(24)} ${trigger.padEnd(24)} last:${lastRun.padEnd(20)} ${runs}`,
        );
      }
    });

  return cmd;
}
