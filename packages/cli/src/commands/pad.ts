import { readFileSync, writeFileSync } from "node:fs";
import { resolveApiBase } from "@orc/core/config";
import { SCRATCHPAD_KINDS, scratchpadFilename } from "@orc/core/scratchpad";
import { createOrcClient } from "@orc/sdk/client";
import type { ApiResult, Scratchpad, ScratchpadKind } from "@orc/sdk/types";
import { Command } from "commander";
import { isJson, jsonOut } from "../output.js";
import { resolveProject } from "./project.js";

const AUTHOR = "cli";

/** The calling agent's native session id; a new pad links to it. */
function sessionId(): string | undefined {
  return process.env.ORC_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || undefined;
}

function unwrap<T>(result: ApiResult<T>): T {
  if (result.error) {
    console.error(`Error: ${result.error.error}`);
    process.exit(1);
  }
  return result.data as T;
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function padLink(id: string): string {
  return new URL(`/scratchpad/${id}`, resolveApiBase()).toString();
}

function parseKind(kind: string): ScratchpadKind {
  if (!(SCRATCHPAD_KINDS as readonly string[]).includes(kind))
    fail(`kind must be one of ${SCRATCHPAD_KINDS.join(", ")}`);
  return kind as ScratchpadKind;
}

function parseRevision(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) fail(`revision must be a positive integer, got: ${value}`);
  return n;
}

const collect = (value: string, previous: string[]) => [...previous, value];

function printHeader(pad: Scratchpad) {
  console.log(`# ${pad.title}  (${pad.kind}, revision ${pad.revision})`);
  console.log(`  id: ${pad.id}  author: ${pad.author}  updated: ${formatTime(pad.updated_at)}`);
  if (pad.tags.length) console.log(`  tags: ${pad.tags.join(", ")}`);
  console.log(`  link: ${padLink(pad.id)}`);
}

export function padCommand() {
  const cmd = new Command("pad").description(
    "Manage scratchpads: markdown docs, Excalidraw diagrams and HTML pages kept for later",
  );

  cmd
    .command("ls")
    .description("List scratchpads, most recently updated first")
    .option("-k, --kind <kind>", `Only this kind (${SCRATCHPAD_KINDS.join("|")})`)
    .option("-p, --project <name>", "Only this project's pads")
    .option("--unassigned", "Only pads without a project")
    .option(
      "-s, --session <id>",
      "Only pads linked to this native session id ('current' = $ORC_SESSION_ID)",
    )
    .option("-t, --tag <tag>", "Only pads with this tag")
    .option("-q, --q <text>", "Search title and content")
    .option("-l, --limit <n>", "Max results", "50")
    .action(
      async (opts: {
        kind?: string;
        project?: string;
        unassigned?: boolean;
        session?: string;
        tag?: string;
        q?: string;
        limit: string;
      }) => {
        const client = createOrcClient({ source: "cli" });
        const project = opts.project
          ? await resolveProject(client, { project: opts.project })
          : undefined;
        if (opts.project && !project) fail(`Project not found: ${opts.project}`);
        const session = opts.session === "current" ? sessionId() : opts.session;
        if (opts.session === "current" && !session)
          fail("No current session: ORC_SESSION_ID and CLAUDE_CODE_SESSION_ID are unset");
        const data = unwrap(
          await client.scratchpads.list({
            kind: opts.kind ? parseKind(opts.kind) : undefined,
            project_id: project?.id,
            unassigned: opts.unassigned,
            session_id: session,
            tag: opts.tag,
            q: opts.q,
            limit: Number(opts.limit),
          }),
        );
        if (isJson()) return jsonOut(data);
        if (data.scratchpads.length === 0) return console.log("No scratchpads found.");
        for (const pad of data.scratchpads)
          console.log(
            `  ${pad.id}  ${pad.kind.padEnd(7)} r${String(pad.revision).padEnd(4)} ${formatTime(pad.updated_at)}  ${pad.title}`,
          );
        if (data.total > data.scratchpads.length)
          console.log(`  ... ${data.total - data.scratchpads.length} more (use --limit)`);
      },
    );

  cmd
    .command("show <id>")
    .description("Show a scratchpad's details and content")
    .action(async (id: string) => {
      const pad = unwrap(await createOrcClient({ source: "cli" }).scratchpads.get(id));
      if (isJson()) return jsonOut(pad);
      printHeader(pad);
      console.log();
      console.log(pad.content);
    });

  cmd
    .command("new <kind> <title>")
    .description(`Create a scratchpad (${SCRATCHPAD_KINDS.join("|")}), optionally from a file`)
    .option("-f, --file <path>", "Initial content (.md, .excalidraw or .html)")
    .option("-p, --project <name>", "Link to a project")
    .option("-t, --tag <tag>", "Tag (repeatable)", collect, [])
    .option("--no-session", "Do not link the pad to the current agent session")
    .action(
      async (
        kind: string,
        title: string,
        opts: { file?: string; project?: string; tag: string[]; session: boolean },
      ) => {
        const client = createOrcClient({ source: "cli" });
        const project = opts.project
          ? await resolveProject(client, { project: opts.project })
          : undefined;
        if (opts.project && !project) fail(`Project not found: ${opts.project}`);
        const session_id = opts.session ? sessionId() : undefined;
        const pad = unwrap(
          await client.scratchpads.create({
            kind: parseKind(kind),
            title,
            ...(opts.file ? { content: readFileSync(opts.file, "utf8") } : {}),
            ...(project ? { project_id: project.id } : {}),
            ...(session_id ? { session_id } : {}),
            ...(opts.tag.length ? { tags: opts.tag } : {}),
            author: AUTHOR,
          }),
        );
        if (isJson()) return jsonOut(pad);
        console.log(`Created ${pad.kind} scratchpad ${pad.id}: ${padLink(pad.id)}`);
      },
    );

  cmd
    .command("pull <id> [file]")
    .description("Write a scratchpad's file to disk (default name from its title and kind)")
    .action(async (id: string, file: string | undefined) => {
      const pad = unwrap(await createOrcClient({ source: "cli" }).scratchpads.get(id));
      const path = file ?? scratchpadFilename(pad.title, pad.kind);
      writeFileSync(path, pad.content);
      if (isJson()) return jsonOut({ id: pad.id, path, revision: pad.revision });
      console.log(
        `Wrote ${path} (revision ${pad.revision}); push with --if-revision ${pad.revision}`,
      );
    });

  cmd
    .command("push <id> <file>")
    .description("Replace a scratchpad's content with a file")
    .option("-r, --if-revision <n>", "Refuse if the pad moved past this revision (from pull)")
    .action(async (id: string, file: string, opts: { ifRevision?: string }) => {
      const pad = unwrap(
        await createOrcClient({ source: "cli" }).scratchpads.update(id, {
          content: readFileSync(file, "utf8"),
          ...(opts.ifRevision ? { if_revision: parseRevision(opts.ifRevision) } : {}),
          author: AUTHOR,
        }),
      );
      if (isJson()) return jsonOut(pad);
      console.log(`Pushed ${file} to ${pad.id} (revision ${pad.revision})`);
    });

  cmd
    .command("rm <id>")
    .description("Delete a scratchpad (cannot be undone)")
    .action(async (id: string) => {
      unwrap(await createOrcClient({ source: "cli" }).scratchpads.delete(id));
      if (isJson()) return jsonOut({ deleted: id });
      console.log(`Deleted scratchpad ${id}`);
    });

  return cmd;
}
