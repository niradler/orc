#!/usr/bin/env bun
import { existsSync, statSync } from "node:fs";
import { loadConfig } from "@orc/core/config";
import { ORC_VERSION } from "@orc/core/version";
import { Command } from "commander";
import { agentCommand, agentPackageCommand } from "./commands/agent.js";
import { attentionCommand } from "./commands/attention.js";
import { daemonCommand, ORC_HOME, ORC_PID, readDaemonPid } from "./commands/daemon.js";
import { doctorCommand } from "./commands/doctor.js";
import { flowCommand } from "./commands/flow.js";
import { gatewayCommand } from "./commands/gateway.js";
import { jobCommand } from "./commands/job.js";
import { kbCommand, kbParserWorkerCommand } from "./commands/kb.js";
import { memCommand } from "./commands/mem.js";
import { padCommand } from "./commands/pad.js";
import { projectCommand } from "./commands/project.js";
import { rulesCommand } from "./commands/rules.js";
import { schemaCommand } from "./commands/schema.js";
import { sessionCommand } from "./commands/session.js";
import { skillCommand } from "./commands/skill.js";
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
  json?: boolean;
};

const program = new Command()
  .name("orc")
  .description("Human + AI Orchestration Hub")
  .version(ORC_VERSION)
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
  .option("--json", "Machine-readable JSON output")
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
program.addCommand(attentionCommand());
program.addCommand(rulesCommand());
program.addCommand(projectCommand());
program.addCommand(memCommand());
program.addCommand(padCommand());
program.addCommand(jobCommand());
program.addCommand(sessionCommand());
program.addCommand(daemonCommand());
program.addCommand(gatewayCommand());
program.addCommand(skillCommand());
program.addCommand(agentCommand());
program.addCommand(agentPackageCommand());
program.addCommand(flowCommand());
program.addCommand(kbCommand());
program.addCommand(kbParserWorkerCommand(), { hidden: true });
program.addCommand(statusCommand());
program.addCommand(doctorCommand());
program.addCommand(schemaCommand());

program
  .command("api")
  .description("Start the API server (use --port / --host / --db / --secret to configure)")
  .action(async () => {
    await import("@orc/api");
    await new Promise(() => {});
  });

program
  .command("home")
  .description("Show ~/.orc directory contents and daemon state")
  .action(() => {
    const config = loadConfig();

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
  .option("--mode <mode>", "tool surface: meta (default; tool_search/describe/invoke) or full")
  .action(async (opts: { mode?: string }) => {
    // Import the modules, not the @orc/mcp barrel: the bundled barrel does not await its
    // async children, so the tool registry would still be undefined when clients call it.
    const [{ parseMcpMode }, { startStdioServer }] = await Promise.all([
      import("@orc/mcp/meta-tools"),
      import("@orc/mcp/server"),
    ]);
    await startStdioServer(parseMcpMode(opts.mode ?? "meta"));
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
