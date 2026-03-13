#!/usr/bin/env bun
import { existsSync, statSync } from "node:fs";
import { Command } from "commander";
import { daemonCommand, ORC_HOME, ORC_PID, readDaemonPid } from "./commands/daemon.js";
import { gatewayCommand } from "./commands/gateway.js";
import { jobCommand } from "./commands/job.js";
import { memCommand } from "./commands/mem.js";
import { sessionCommand } from "./commands/session.js";
import { statusCommand } from "./commands/status.js";
import { taskCommand } from "./commands/task.js";

type GlobalOpts = {
  db?: string;
  port?: string;
  host?: string;
  secret?: string;
  logLevel?: string;
  runnerTimeout?: string;
  runnerMaxJobs?: string;
  snapshotMaxBytes?: string;
};

const program = new Command()
  .name("orc")
  .description("Human + AI Orchestration Hub")
  .version("0.0.1")
  .option("--db <path>", "DB file path (overrides ORC_DB_PATH / config.json)")
  .option("--port <n>", "API port (overrides ORC_API_PORT / config.json)")
  .option("--host <host>", "API host (overrides ORC_API_HOST / config.json)")
  .option("--secret <secret>", "API bearer secret (overrides ORC_API_SECRET / config.json)")
  .option("--log-level <level>", "Log level: debug|info|warn|error (overrides ORC_LOG_LEVEL)")
  .option(
    "--runner-timeout <secs>",
    "Default job timeout in seconds (overrides ORC_RUNNER_TIMEOUT)",
  )
  .option("--runner-max-jobs <n>", "Max concurrent jobs (overrides ORC_RUNNER_MAX_JOBS)")
  .option(
    "--snapshot-max-bytes <n>",
    "Session snapshot budget bytes (overrides ORC_SNAPSHOT_MAX_BYTES)",
  )
  .hook("preSubcommand", (_thisCmd, subCmd) => {
    void subCmd;
    const opts = program.opts<GlobalOpts>();
    if (opts.db) process.env.ORC_DB_PATH = opts.db;
    if (opts.port) process.env.ORC_API_PORT = opts.port;
    if (opts.host) process.env.ORC_API_HOST = opts.host;
    if (opts.secret) process.env.ORC_API_SECRET = opts.secret;
    if (opts.logLevel) process.env.ORC_LOG_LEVEL = opts.logLevel;
    if (opts.runnerTimeout) process.env.ORC_RUNNER_TIMEOUT = opts.runnerTimeout;
    if (opts.runnerMaxJobs) process.env.ORC_RUNNER_MAX_JOBS = opts.runnerMaxJobs;
    if (opts.snapshotMaxBytes) process.env.ORC_SNAPSHOT_MAX_BYTES = opts.snapshotMaxBytes;
  });

program.addCommand(taskCommand());
program.addCommand(memCommand());
program.addCommand(jobCommand());
program.addCommand(sessionCommand());
program.addCommand(daemonCommand());
program.addCommand(gatewayCommand());
program.addCommand(statusCommand());

program
  .command("api")
  .description("Start the API server (use --port / --host / --db / --secret to configure)")
  .action(async () => {
    await import("@orc/api" as string);
    await new Promise(() => {});
  });

program
  .command("home")
  .description("Show ~/.orc directory contents and daemon state")
  .action(async () => {
    const { loadConfig } = await import("@orc/core/config" as string);
    const config = (loadConfig as typeof import("@orc/core/config").loadConfig)();

    console.log(`ORC home: ${ORC_HOME}\n`);

    const files = [
      { label: "DB", path: config.db.path },
      { label: "config", path: `${ORC_HOME}/config.json` },
      { label: "pid", path: ORC_PID },
      { label: "daemon log", path: `${ORC_HOME}/daemon.log` },
    ];

    for (const file of files) {
      if (existsSync(file.path)) {
        const kb = Math.round(statSync(file.path).size / 1024);
        console.log(`  ✓ ${file.label.padEnd(12)} ${file.path}  (${kb}KB)`);
      } else {
        console.log(`  · ${file.label.padEnd(12)} ${file.path}  (not found)`);
      }
    }

    const daemonPid = readDaemonPid();
    console.log();
    if (daemonPid) {
      try {
        process.kill(daemonPid, 0);
        console.log(`  daemon  ● running  pid:${daemonPid}`);
      } catch {
        console.log(`  daemon  ○ stopped  (stale pid: ${daemonPid})`);
      }
    } else {
      console.log("  daemon  ○ not running");
    }
    console.log();
    console.log(
      `  config  port:${config.api.port}  host:${config.api.host}  secret:${config.api.secret ? "***" : "(none)"}`,
    );
  });

program
  .command("mcp")
  .description("Start the MCP server (stdio)")
  .action(async () => {
    const { startStdioServer } = await import("@orc/mcp" as string);
    await (startStdioServer as () => Promise<void>)();
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
