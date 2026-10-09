import { createOrcClient } from "@orc/sdk/client";
import { Command } from "commander";
import { jsonOut } from "../output.js";
import { resolveProject } from "./project.js";

export function wikiCommand(): Command {
  const command = new Command("wiki").description(
    "Read maintained wiki and retrieve cited evidence",
  );
  command
    .command("list")
    .option("-p, --project <name>", "Project name")
    .option("--slug <slug>", "Include page revision history")
    .action(async (opts: { project?: string; slug?: string }) => {
      const client = createOrcClient();
      const project = await resolveProject(client, {
        ...(opts.project ? { project: opts.project } : {}),
        noProject: false,
      });
      const result = await client.wiki.read(project?.id, opts.slug);
      if (result.error) {
        process.exitCode = 1;
        return console.error(result.error.error);
      }
      jsonOut(result.data);
    });
  command
    .command("evolution")
    .description("Inspect skill proposals, evaluations, promotion and revert history")
    .option("-p, --project <name>", "Project name")
    .action(async (opts: { project?: string }) => {
      const client = createOrcClient();
      const project = await resolveProject(client, {
        ...(opts.project ? { project: opts.project } : {}),
        noProject: false,
      });
      const [history, proposals] = await Promise.all([
        client.evolution.history(project?.id),
        client.evolution.proposals(project?.id),
      ]);
      if (history.error || proposals.error) {
        process.exitCode = 1;
        return console.error(history.error?.error ?? proposals.error?.error);
      }
      jsonOut({ ...history.data, ...proposals.data });
    });
  command
    .command("revert <activation>")
    .description("Restore the previous skill version and retain the change history")
    .requiredOption("--reason <reason>", "Reason for reverting")
    .option("-p, --project <name>", "Project name")
    .action(async (activation: string, opts: { project?: string; reason: string }) => {
      const client = createOrcClient();
      const project = await resolveProject(client, {
        ...(opts.project ? { project: opts.project } : {}),
        noProject: false,
      });
      const result = await client.evolution.revert(activation, project?.id ?? null, opts.reason);
      if (result.error) {
        process.exitCode = 1;
        return console.error(result.error.error);
      }
      jsonOut(result.data);
    });
  command
    .command("search <query>")
    .option("-p, --project <name>", "Project name")
    .option("--budget <tokens>", "Estimated token budget", "2000")
    .option("--tag <tag>", "Require a topic tag")
    .action(async (query: string, opts: { project?: string; budget: string; tag?: string }) => {
      const client = createOrcClient();
      const project = await resolveProject(client, {
        ...(opts.project ? { project: opts.project } : {}),
        noProject: false,
      });
      const result = await client.evidence.search({
        query,
        project_id: project?.id ?? null,
        token_budget: Number(opts.budget),
        tags_all: opts.tag ? [opts.tag] : [],
      });
      if (result.error) {
        process.exitCode = 1;
        return console.error(result.error.error);
      }
      jsonOut(result.data);
    });
  return command;
}
