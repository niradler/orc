import { createOrcClient } from "@orc/sdk/client";
import { Command } from "commander";
import { isJson, jsonErr, jsonOut } from "../output.js";
import { listAllJobs } from "./job.js";

export function statusCommand() {
  return new Command("status").description("Show system status").action(async () => {
    const client = createOrcClient();
    const { data, error } = await client.health.check();
    if (error || !data) {
      const message = "API unreachable - is `orc api` running?";
      if (isJson()) jsonErr(message);
      console.error(message);
      process.exitCode = 1;
      return;
    }

    const [{ data: tasks }, { jobs }, { data: mems }] = await Promise.all([
      client.tasks.list({ limit: 100 }),
      listAllJobs(client),
      client.memories.list({ sort: "recent", limit: 10 }),
    ]);

    if (isJson())
      return jsonOut({
        api: data,
        tasks: tasks?.tasks ?? [],
        jobs,
        memories: mems?.memories ?? [],
        memories_total: mems?.total ?? 0,
      });

    console.log(`orc API  ● running  v${data.version}  uptime: ${data.uptime}s`);
    const loop = data.agent_loop;
    if (!loop) {
      console.log(`agent loop  ? unknown  this API predates /health reporting it`);
    } else if (loop.enabled) {
      console.log(
        `agent loop  ● on  polling every ${loop.poll_interval_minutes}m, up to ${loop.max_workers} worker(s) - todo and changes_requested tasks are picked up automatically`,
      );
    } else {
      console.log(`agent loop  ○ off  no task is picked up automatically`);
    }

    const taskCounts = countBy(tasks?.tasks ?? [], "status");
    console.log(`\nTasks:`);
    for (const [s, n] of Object.entries(taskCounts)) {
      console.log(`  ${s.padEnd(20)} ${n}`);
    }

    console.log(`\nJobs: ${jobs.length} defined`);
    console.log(`Memories: ${mems?.total ?? 0} across all projects`);
  });
}

function countBy<T extends Record<string, unknown>>(
  arr: T[],
  key: keyof T,
): Record<string, number> {
  return arr.reduce<Record<string, number>>((acc, item) => {
    const val = String(item[key]);
    acc[val] = (acc[val] ?? 0) + 1;
    return acc;
  }, {});
}
