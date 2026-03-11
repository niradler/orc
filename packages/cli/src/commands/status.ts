import { createOrcClient } from "@orc/sdk/client";
import { Command } from "commander";

export function statusCommand() {
  return new Command("status").description("Show system status").action(async () => {
    const client = createOrcClient();
    const { data, error } = await client.health.check();
    if (error) {
      console.error("API unreachable — is `orc api` running?");
      return;
    }
    console.log(`orc API  ● running  v${data!.version}  uptime: ${data!.uptime}s`);

    const { data: tasks } = await client.tasks.list({ limit: 100 });
    const { data: jobs } = await client.jobs.list();
    const { data: mems } = await client.memories.list();

    const taskCounts = countBy(tasks?.tasks ?? [], "status");
    console.log(`\nTasks:`);
    for (const [s, n] of Object.entries(taskCounts)) {
      console.log(`  ${s.padEnd(20)} ${n}`);
    }

    console.log(`\nJobs: ${jobs?.jobs.length ?? 0} defined`);
    console.log(`Memory: ${mems?.memories.length ?? 0} recent entries`);
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
