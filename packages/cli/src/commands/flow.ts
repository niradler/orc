import { readFileSync } from "node:fs";
import { createOrcClient } from "@orc/sdk/client";
import type { FlowRun } from "@orc/sdk/types";
import { Command } from "commander";
import { isJson, jsonOut } from "../output.js";

function color(text: string, code: string) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

const STATUS_COLOR: Record<string, string> = {
  running: "36",
  succeeded: "32",
  completed: "32",
  failed: "31",
  halted: "31",
  cancelled: "90",
  pending: "33",
  awaiting_human: "35",
  skipped: "90",
};

function statusLabel(status: string): string {
  return color(status, STATUS_COLOR[status] ?? "0");
}

async function readDefinition(opts: {
  file?: string;
  definition?: string;
}): Promise<Record<string, unknown>> {
  let raw: string;
  if (opts.file) {
    raw = readFileSync(opts.file, "utf-8");
  } else if (opts.definition) {
    raw = opts.definition;
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    raw = Buffer.concat(chunks).toString("utf-8");
  }
  if (!raw.trim()) {
    throw new Error("No definition provided. Use --file, --definition, or pipe JSON via stdin.");
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

function printRun(run: FlowRun): void {
  console.log(color(`# ${run.flow_name}`, "1") + color(` [${run.flow_source}]`, "90"));
  console.log(`  run:      ${run.id}`);
  console.log(`  task:     ${run.task_id}`);
  console.log(`  status:   ${statusLabel(run.status)}`);
  if (run.halt_description) console.log(`  halted:   ${run.halt_description}`);
  console.log(`  executed: ${run.node_executions} node(s)`);

  if (run.active.length > 0) {
    console.log(`  active:   ${run.active.map((a) => `${a.nodeId}#${a.attempt}`).join(", ")}`);
  }
  const visits = Object.entries(run.visits);
  if (visits.length > 0) {
    console.log(`  visits:   ${visits.map(([n, count]) => `${n}×${count}`).join(", ")}`);
  }
  const vars = Object.entries(run.vars).filter(
    ([k]) => !["task_id", "task_title", "project_id"].includes(k),
  );
  if (vars.length > 0) {
    console.log(
      `  vars:     ${vars
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(", ")}`,
    );
  }

  if (run.nodes.length > 0) {
    console.log();
    console.log(color("Ledger", "1"));
    for (const node of run.nodes) {
      const verdict = node.outcome ? color(`→ ${node.outcome}`, "32") : "";
      console.log(
        `  ${node.node_id}#${node.attempt} ${color(`(${node.node_kind})`, "90")} ` +
          `[${statusLabel(node.status)}] ${verdict}`,
      );
      if (node.summary) {
        for (const line of node.summary.trim().split("\n")) console.log(`      ${line}`);
      }
      if (node.error) console.log(`      ${color(`error: ${node.error}`, "31")}`);
    }
  }
}

export function flowCommand() {
  const cmd = new Command("flow").description("Manage task flow graphs (nodes, edges, loops)");

  cmd
    .command("list")
    .description("List available flows")
    .option("-q, --query <q>", "Keyword search")
    .option("--source <source>", "Filter by source (builtin|user|project)")
    .option("--reload", "Rescan the flow directories")
    .action(async (opts) => {
      const client = createOrcClient();
      const { data, error } = await client.flows.list({
        q: opts.query,
        source: opts.source,
        reload: opts.reload,
      });
      if (error) return console.error("Error:", error.error);
      const flows = data?.flows ?? [];
      if (isJson()) return jsonOut(data);
      if (flows.length === 0) return console.log("No flows found.");

      for (const f of flows) {
        const src =
          f.source === "builtin" ? color(" [builtin]", "90") : color(` [${f.source}]`, "36");
        console.log(`  ${f.name.padEnd(24)}${src}  ${f.node_count} nodes, ${f.edge_count} edges`);
        if (f.description) console.log(`    ${color(f.description, "90")}`);
      }
      for (const b of data?.broken ?? []) {
        console.error(color(`  ${b.name}: invalid — ${b.errors.join("; ")}`, "31"));
      }
    });

  cmd
    .command("show <name>")
    .description("Show a flow definition")
    .action(async (name: string) => {
      const client = createOrcClient();
      const { data, error } = await client.flows.read(name);
      if (error) return console.error("Error:", error.error);
      if (!data) return console.error("Flow not found.");
      if (isJson()) return jsonOut(data);

      console.log(color(`# ${data.name}`, "1") + color(` v${data.version} [${data.source}]`, "90"));
      if (data.description) console.log(`  ${data.description}`);
      console.log(`  entry: ${data.entry}`);
      console.log(`  path:  ${data.path ?? "(built in)"}`);
      console.log();
      console.log(JSON.stringify(data.definition, null, 2));
    });

  cmd
    .command("validate")
    .description("Validate a flow definition without saving it")
    .option("-f, --file <path>", "Read the definition from a JSON file")
    .option("-d, --definition <json>", "Inline JSON definition")
    .action(async (opts) => {
      let definition: Record<string, unknown>;
      try {
        definition = await readDefinition(opts);
      } catch (err) {
        return console.error("Error:", err instanceof Error ? err.message : String(err));
      }
      const client = createOrcClient();
      const { data, error } = await client.flows.validate(definition);
      if (error) return console.error("Error:", error.error);
      if (isJson()) return jsonOut(data);
      if (data?.valid) return console.log(color("Valid flow definition.", "32"));
      console.error(color("Invalid flow definition:", "31"));
      for (const e of data?.errors ?? []) console.error(`  ${e}`);
      process.exitCode = 1;
    });

  cmd
    .command("create")
    .description("Create a reusable user flow in ~/.orc/flows/<name>/flow.json")
    .option("-f, --file <path>", "Read the definition from a JSON file")
    .option("-d, --definition <json>", "Inline JSON definition")
    .option("--overwrite", "Replace an existing user flow of the same name")
    .action(async (opts) => {
      let definition: Record<string, unknown>;
      try {
        definition = await readDefinition(opts);
      } catch (err) {
        return console.error("Error:", err instanceof Error ? err.message : String(err));
      }
      const client = createOrcClient();
      const { data, error } = await client.flows.create({
        definition,
        overwrite: opts.overwrite,
      });
      if (error) return console.error("Error:", error.error);
      if (!data) return console.error("Failed to create flow.");
      if (isJson()) return jsonOut(data);
      console.log(`Created flow: ${data.name} at ${data.path}`);
    });

  cmd
    .command("attach <taskId>")
    .description("Attach a flow to a task, by name or as an inline graph for that task alone")
    .option("-n, --name <flow>", "Named flow to attach")
    .option("-f, --file <path>", "Inline definition from a JSON file")
    .option("-d, --definition <json>", "Inline JSON definition")
    .option("--start", "Start the flow immediately instead of waiting for the loop")
    .action(async (taskId: string, opts) => {
      if (!opts.name && !opts.file && !opts.definition) {
        return console.error("Error: pass --name, or --file/--definition for an inline flow.");
      }
      let definition: Record<string, unknown> | undefined;
      if (opts.file || opts.definition) {
        try {
          definition = await readDefinition(opts);
        } catch (err) {
          return console.error("Error:", err instanceof Error ? err.message : String(err));
        }
      }
      const client = createOrcClient();
      const { data, error } = await client.tasks.attachFlow(taskId, {
        ...(opts.name ? { name: opts.name } : {}),
        ...(definition ? { definition } : {}),
        start: Boolean(opts.start),
      });
      if (error) return console.error("Error:", error.error);
      if (isJson()) return jsonOut(data);
      console.log(`Attached flow "${data?.attached}" to task ${taskId}.`);
      if (data?.started) console.log(`Started run ${data.flow_run_id}.`);
      else if (data?.error) console.error(`Could not start: ${data.error}`);
      else console.log("It starts on the next loop cycle.");
    });

  cmd
    .command("status <taskId>")
    .description("Show a task's flow run and its ledger")
    .action(async (taskId: string) => {
      const client = createOrcClient();
      const { data, error } = await client.tasks.flow(taskId);
      if (error) return console.error("Error:", error.error);
      if (!data) return console.error("No flow run for this task.");
      if (isJson()) return jsonOut(data);
      printRun(data);
    });

  cmd
    .command("resume <taskId>")
    .description("Resolve a node that is waiting for a human, so the flow continues")
    .requiredOption("-o, --outcome <outcome>", "Outcome to report")
    .option("-s, --summary <text>", "Comment recorded with the decision")
    .option("--var <key=value...>", "Set a flow var (repeatable)")
    .action(async (taskId: string, opts) => {
      const vars: Record<string, unknown> = {};
      for (const pair of (opts.var ?? []) as string[]) {
        const idx = pair.indexOf("=");
        if (idx === -1) return console.error(`Error: --var expects key=value, got "${pair}"`);
        const key = pair.slice(0, idx);
        const raw = pair.slice(idx + 1);
        vars[key] =
          raw === "true"
            ? true
            : raw === "false"
              ? false
              : Number.isNaN(Number(raw))
                ? raw
                : Number(raw);
      }
      const client = createOrcClient();
      const { data, error } = await client.tasks.resumeFlow(taskId, {
        outcome: opts.outcome,
        ...(opts.summary ? { summary: opts.summary } : {}),
        ...(Object.keys(vars).length > 0 ? { vars } : {}),
        author: "human",
      });
      if (error) return console.error("Error:", error.error);
      if (isJson()) return jsonOut(data);
      const next = data?.next_nodes ?? [];
      const running = next.length > 0 ? ` Now running: ${next.join(", ")}` : "";
      console.log(`Reported "${opts.outcome}".${running}`);
    });

  cmd
    .command("halt <taskId>")
    .description("Stop a task's running flow and kill its live nodes")
    .option("-r, --reason <text>", "Why", "halted from the CLI")
    .action(async (taskId: string, opts) => {
      const client = createOrcClient();
      const { data, error } = await client.tasks.haltFlow(taskId, opts.reason);
      if (error) return console.error("Error:", error.error);
      if (isJson()) return jsonOut(data);
      console.log(data?.halted ? "Flow halted." : "No running flow on that task.");
    });

  return cmd;
}
