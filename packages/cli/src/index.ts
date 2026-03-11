#!/usr/bin/env bun
import { Command } from "commander";
import { jobCommand } from "./commands/job.js";
import { memCommand } from "./commands/mem.js";
import { statusCommand } from "./commands/status.js";
import { taskCommand } from "./commands/task.js";

const program = new Command()
  .name("orc")
  .description("Human + AI Orchestration Hub")
  .version("0.0.1");

program.addCommand(taskCommand());
program.addCommand(memCommand());
program.addCommand(jobCommand());
program.addCommand(statusCommand());

program
  .command("api")
  .description("Start the API server")
  .option("-p, --port <port>", "Port to listen on", "7700")
  .option("-H, --host <host>", "Host to bind to", "127.0.0.1")
  .action(async (opts: { port: string; host: string }) => {
    process.env["ORC_API_PORT"] = opts.port;
    process.env["ORC_API_HOST"] = opts.host;
    const { createApp } = await import("@orc/api" as string);
    const { loadConfig } = await import("@orc/core/config" as string);
    const config = loadConfig();
    const app = (createApp as () => { fetch: (r: Request) => Response })();
    Bun.serve({ port: Number(opts.port), hostname: opts.host, fetch: app.fetch });
    console.log(`API running on http://${config.api.host}:${config.api.port}`);
    console.log(`Docs: http://${config.api.host}:${config.api.port}/docs`);
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
