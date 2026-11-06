import { readFileSync } from "node:fs";
import type { NeedsReentry } from "@orc/core/project-bundle";
import { createOrcClient } from "@orc/sdk/client";
import { Command } from "commander";
import { isJson, jsonOut } from "../output.js";

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function unwrap<T>(result: { data: T | null; error: { error: string } | null }): T {
  if (result.error || result.data == null) fail(result.error?.error ?? "Request failed");
  return result.data;
}

function printNeeds(needs: NeedsReentry[]) {
  if (!needs.length) return;
  console.error("Needs re-entry:");
  for (const item of needs)
    console.error(`  ${item.kind} ${item.name}: ${item.field} — ${item.reason}`);
}

export function exportCommand() {
  return new Command("export")
    .description(
      "Write a project bundle to stdout. Secrets are omitted and listed as needs re-entry.",
    )
    .requiredOption("-p, --project <name>", "Project name or id")
    .action(async (opts: { project: string }) => {
      const client = createOrcClient({ source: "cli" });
      const bundle = unwrap(await client.transfer.exportProject(opts.project));
      console.log(JSON.stringify(bundle, null, 2));
      printNeeds(bundle.needs_reentry);
    });
}

export function importCommand() {
  return new Command("import")
    .description("Import a project bundle produced by orc export")
    .argument("<file>", "Bundle JSON file, or - to read stdin")
    .action(async (file: string) => {
      const text = file === "-" ? await Bun.stdin.text() : readFileSync(file, "utf8");
      let bundle: unknown;
      try {
        bundle = JSON.parse(text);
      } catch {
        fail("Bundle is not valid JSON");
      }
      const client = createOrcClient({ source: "cli" });
      const result = unwrap(await client.transfer.importBundle(bundle as never));
      if (isJson()) return jsonOut(result);
      const where = result.project_name ?? "unscoped tasks";
      console.log(
        `${result.created_project ? "Created" : "Updated"} ${where}: ${result.counts.tasks} tasks, ${result.counts.comments} comments, ${result.counts.memories} memories, ${result.counts.jobs} jobs`,
      );
      printNeeds(result.needs_reentry);
      for (const issued of result.issued)
        console.log(`Webhook ${issued.name}\n  token: ${issued.token}\n  secret: ${issued.secret}`);
      for (const skip of result.skipped)
        console.log(`Skipped ${skip.kind} ${skip.name}: ${skip.reason}`);
    });
}
