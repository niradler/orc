import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { loadConfig } from "@orc/core/config";
import {
  KB_CALL_SOURCES,
  KB_SCOPES,
  KB_SEARCH_MODES,
  type KbCallSource,
  type KbScope,
  type KbSearchMode,
} from "@orc/core/kb";
import { PARSER_WORKER_COMMAND, runParserWorker } from "@orc/knowledge";
import { createOrcClient, type OrcClient } from "@orc/sdk/client";
import { Command, Option } from "commander";
import { isJson, jsonOut } from "../output.js";

type ProjectOpts = { project?: string | false };

/** CLI reads are accounted as source "cli"; an ORC agent shelling out is attributed to its session. */
async function kbClient(opts: ProjectOpts = {}): Promise<OrcClient> {
  const base = createOrcClient({ source: "cli" });
  if (opts.project === false) return base;
  const name = opts.project ?? loadConfig().activeProject;
  if (!name) return base;
  const { data, error } = await base.projects.getByName(name);
  if (error || !data) fail(`Project not found: ${name}`);
  return createOrcClient({ source: "cli", project_id: data.id });
}

function fail(message: string): never {
  console.error(isJson() ? JSON.stringify({ error: message }) : `Error: ${message}`);
  process.exit(1);
}

function unwrap<T>(r: { data: T | null; error: { error: string } | null }): T {
  if (r.error) fail(r.error.error);
  return r.data as T;
}

/** Accepts a KB ID or its exact name (case-insensitive) among the visible KBs. */
async function resolveKb(client: OrcClient, ref: string): Promise<string> {
  const { knowledge_bases } = unwrap(await client.kb.list({ scope: "all" }));
  const hit =
    knowledge_bases.find((k) => k.id === ref) ??
    knowledge_bases.filter((k) => k.name.toLowerCase() === ref.toLowerCase());
  if (!Array.isArray(hit)) return hit.id;
  if (hit.length === 1 && hit[0]) return hit[0].id;
  if (hit.length > 1) fail(`Several knowledge bases are named "${ref}"; use its ID`);
  return fail(`Knowledge base not found: ${ref}`);
}

const projectOption = () => new Option("-p, --project <name>", "Project (default: active project)");
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const date = (ms: number | null | undefined) =>
  ms ? new Date(ms).toISOString().slice(0, 16) : "-";
const list = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
function editableBy(v: string): KbCallSource[] {
  if (v.trim() === "none") return [];
  const sources = list(v);
  const bad = sources.filter((s) => !(KB_CALL_SOURCES as readonly string[]).includes(s));
  if (bad.length) fail(`Unknown source ${bad.join(", ")}; use ${KB_CALL_SOURCES.join(",")}`);
  return [...new Set(sources)] as KbCallSource[];
}

export function kbCommand() {
  const cmd = new Command("kb").description(
    "Knowledge bases: documents, uploads, search with citations",
  );

  cmd
    .command("list")
    .description("List knowledge bases (active project's and global)")
    .addOption(projectOption())
    .option("--no-project", "Global knowledge bases only")
    .addOption(new Option("-s, --scope <scope>", "default|project|global|all").choices(KB_SCOPES))
    .action(async (opts: ProjectOpts & { scope?: KbScope }) => {
      const client = await kbClient(opts);
      const { knowledge_bases } = unwrap(await client.kb.list({ scope: opts.scope ?? "default" }));
      if (isJson()) return jsonOut({ knowledge_bases });
      if (!knowledge_bases.length) return console.log("No knowledge bases.");
      for (const kb of knowledge_bases) {
        const scope = kb.project_id ? "project" : "global";
        const editable = kb.editable_by.length ? kb.editable_by.join(",") : "none";
        console.log(
          `${kb.id}  ${kb.name} [${scope}] ${kb.document_count} docs  editable by ${editable}`,
        );
      }
    });

  cmd
    .command("create <name>")
    .description("Create a knowledge base in the active project (or --global)")
    .addOption(projectOption())
    .option("-g, --global", "Global knowledge base, visible from every project")
    .option("-d, --description <text>", "Description", "")
    .option(
      "--editable-by <sources>",
      `Call sources that may change documents: comma list of ${KB_CALL_SOURCES.join(",")} or 'none' (default: all)`,
      editableBy,
    )
    .action(
      async (
        name: string,
        opts: ProjectOpts & {
          global?: boolean;
          description: string;
          editableBy?: KbCallSource[];
        },
      ) => {
        const client = createOrcClient({ source: "cli" });
        let projectId: string | null = null;
        if (!opts.global) {
          const project = opts.project ?? loadConfig().activeProject;
          if (!project) fail("No project set. Use -p <name>, 'orc project use <name>' or --global");
          projectId = unwrap(await client.projects.getByName(project)).id;
        }
        const kb = unwrap(
          await client.kb.create({
            name,
            description: opts.description,
            project_id: projectId,
            ...(opts.editableBy ? { editable_by: opts.editableBy } : {}),
          }),
        );
        if (isJson()) return jsonOut(kb);
        console.log(`Created ${kb.id} ${kb.name} [${projectId ? "project" : "global"}]`);
      },
    );

  cmd
    .command("editable-by <kb> <sources>")
    .description(
      `Set which call sources may change documents: comma list of ${KB_CALL_SOURCES.join(",")} or 'none'`,
    )
    .action(async (ref: string, raw: string) => {
      const client = await kbClient({ project: false });
      const kb = unwrap(
        await client.kb.update(await resolveKb(client, ref), { editable_by: editableBy(raw) }),
      );
      if (isJson()) return jsonOut(kb);
      console.log(`${kb.id} ${kb.name} editable by ${kb.editable_by.join(",") || "none"}`);
    });

  cmd
    .command("docs <kb>")
    .description("List documents in a knowledge base (ID or name)")
    .option("-f, --folder <path>", "Only this folder")
    .option("-l, --label <label>", "Only this label")
    .action(async (ref: string, opts: { folder?: string; label?: string }) => {
      const client = await kbClient({ project: false });
      const listing = unwrap(
        await client.kb.documents(await resolveKb(client, ref), {
          ...(opts.folder ? { folder: opts.folder } : {}),
          ...(opts.label ? { label: opts.label } : {}),
        }),
      );
      if (isJson()) return jsonOut(listing);
      if (!listing.documents.length) return console.log("No documents.");
      for (const d of listing.documents) {
        const state = d.index_state.endsWith("ready") ? "" : ` ${d.index_state}`;
        const labels = d.labels.length ? ` [${d.labels.join(", ")}]` : "";
        console.log(
          `${d.id}  ${d.path}  "${d.title}" r${d.revision}${state}${d.stale ? " STALE" : ""}${labels}  reads:${d.reads}`,
        );
      }
    });

  cmd
    .command("get <ref>")
    .description("Read a document by ID, or one passage by citation handle kb:<doc>@<rev>#<n>")
    .option("-H, --heading <text>", "Only this heading's section")
    .action(async (ref: string, opts: { heading?: string }) => {
      const client = await kbClient({ project: false });
      const doc = unwrap(
        ref.startsWith("kb:")
          ? await client.kb.citation(ref)
          : await client.kb.document(ref, opts.heading ? { heading: opts.heading } : {}),
      );
      if (isJson()) return jsonOut(doc);
      console.log(`${doc.title}  (${doc.path})  ${doc.id} r${doc.revision}`);
      if (doc.labels.length) console.log(`labels: ${doc.labels.join(", ")}`);
      if (doc.stale) console.log("STALE: a source this was derived from has changed");
      for (const w of doc.warnings) console.log(`warning: ${w}`);
      console.log();
      console.log(doc.content);
    });

  const searchOptions = (c: Command) =>
    c
      .addOption(projectOption())
      .option("--no-project", "Global knowledge bases only")
      .addOption(new Option("-s, --scope <scope>", "default|project|global|all").choices(KB_SCOPES))
      .option("-k, --kb <ids>", "Comma-separated knowledge base IDs", list)
      .option("--labels <labels>", "Comma-separated labels", list)
      .addOption(new Option("-m, --mode <mode>", "Retrieval mode").choices(KB_SEARCH_MODES));
  type SearchOpts = ProjectOpts & {
    scope?: KbScope;
    kb?: string[];
    labels?: string[];
    mode?: KbSearchMode;
  };
  const filters = (o: SearchOpts) => ({
    ...(o.scope ? { scope: o.scope } : {}),
    ...(o.kb ? { kb_ids: o.kb } : {}),
    ...(o.labels ? { labels: o.labels } : {}),
    ...(o.mode ? { mode: o.mode } : {}),
  });

  searchOptions(cmd.command("search <query>").description("Search documents (cited passages)"))
    .option("-l, --limit <n>", "Max documents", "10")
    .action(async (query: string, opts: SearchOpts & { limit: string }) => {
      const client = await kbClient(opts);
      const r = unwrap(
        await client.kb.search({ query, limit: Number(opts.limit), ...filters(opts) }),
      );
      if (isJson()) return jsonOut(r);
      if (r.degraded) console.log(`(${r.degraded})`);
      if (!r.hits.length) return console.log("No documents found.");
      for (const h of r.hits) {
        console.log(`• ${h.title}  [${h.kb_name}]  ${h.path}  ${h.document_id}`);
        for (const p of h.passages.slice(0, 2)) {
          const where = p.heading_path.length ? ` (${p.heading_path.join(" > ")})` : "";
          console.log(`  ${p.citation}${where}: ${flat(p.snippet).slice(0, 160)}`);
        }
      }
    });

  searchOptions(
    cmd.command("evidence <query>").description("Budgeted, cited evidence pack for a question"),
  )
    .option("-b, --budget <tokens>", "Approximate token budget", "6000")
    .action(async (query: string, opts: SearchOpts & { budget: string }) => {
      const client = await kbClient(opts);
      const pack = unwrap(
        await client.kb.evidence({ query, token_budget: Number(opts.budget), ...filters(opts) }),
      );
      if (isJson()) return jsonOut(pack);
      if (!pack.items.length) return console.log(pack.note ?? "No evidence found.");
      for (const i of pack.items) {
        const derived = i.derived ? " (agent-derived)" : "";
        console.log(`\n[${i.citation}] ${i.title} r${i.revision}${derived}`);
        console.log(i.text);
      }
      if (pack.note) console.log(`\n${pack.note}`);
    });

  cmd
    .command("add <kb> <files...>")
    .description("Upload files (Markdown/text become editable documents; PDF/Office are parsed)")
    .option("-t, --title <title>", "Title (single file only)")
    .option("--path <path>", "Path in the knowledge base, e.g. runbooks/deploy.md (single file)")
    .option("--labels <labels>", "Comma-separated labels", list)
    .option("-d, --description <text>", "Description")
    .action(
      async (
        ref: string,
        files: string[],
        opts: { title?: string; path?: string; labels?: string[]; description?: string },
      ) => {
        if (files.length > 1 && (opts.title || opts.path))
          fail("--title and --path apply to a single file");
        const client = await kbClient({ project: false });
        const kbId = await resolveKb(client, ref);
        const results = [];
        let failed = 0;
        for (const file of files) {
          const full = resolve(file);
          if (!statSync(full, { throwIfNoEntry: false })?.isFile()) {
            console.error(`Skipped ${file}: not a file`);
            failed++;
            continue;
          }
          const r = await client.kb.upload(kbId, {
            file: new Blob([readFileSync(full)]),
            name: basename(full),
            ...(opts.title ? { title: opts.title } : {}),
            ...(opts.path ? { path: opts.path } : {}),
            ...(opts.labels ? { labels: opts.labels } : {}),
            ...(opts.description ? { description: opts.description } : {}),
          });
          if (r.error || !r.data) {
            console.error(`Failed ${file}: ${r.error?.error ?? "no response"}`);
            failed++;
            continue;
          }
          results.push(r.data);
          if (!isJson())
            console.log(
              `${r.data.id}  ${r.data.path}  ${r.data.parse_state}/${r.data.index_state}`,
            );
        }
        if (isJson()) jsonOut({ documents: results, failed });
        if (failed) process.exit(1);
      },
    );

  cmd
    .command("rm <document>")
    .description("Delete a document (its revisions and stored originals)")
    .action(async (id: string) => {
      const client = await kbClient({ project: false });
      unwrap(await client.kb.removeDocument(id));
      console.log(`Deleted ${id}`);
    });

  cmd
    .command("reparse <document>")
    .description("Parse an uploaded file again (after enabling Docling or a failure)")
    .action(async (id: string) => {
      const client = await kbClient({ project: false });
      const doc = unwrap(await client.kb.reparse(id));
      if (isJson()) return jsonOut(doc);
      console.log(`${doc.id} queued (${doc.parse_state})`);
    });

  cmd
    .command("history <document>")
    .description("Revision history of a document")
    .action(async (id: string) => {
      const client = await kbClient({ project: false });
      const { revisions } = unwrap(await client.kb.revisions(id));
      if (isJson()) return jsonOut({ revisions });
      for (const r of revisions)
        console.log(
          `r${r.revision}  ${date(r.created_at)}  ${r.actor} (${r.source})  ${r.note || ""}`,
        );
    });

  cmd
    .command("usage <id>")
    .description("Reads by source (mcp/api/cli/ui) for a knowledge base, or a document with --doc")
    .option("--doc", "The ID is a document")
    .action(async (id: string, opts: { doc?: boolean }) => {
      const client = await kbClient({ project: false });
      const u = unwrap(
        opts.doc
          ? await client.kb.documentUsage(id)
          : await client.kb.usage(await resolveKb(client, id)),
      );
      if (isJson()) return jsonOut(u);
      console.log(
        `reads ${u.reads}  exposures ${u.exposures}  sessions ${u.distinct_sessions}  7d ${u.window.days_7}  30d ${u.window.days_30}`,
      );
      for (const [source, kinds] of Object.entries(u.totals)) {
        const reads = kinds.fetch + kinds.cited;
        if (!reads && !kinds.search_hit) continue;
        const last = u.last_read_at[source as keyof typeof u.last_read_at];
        console.log(
          `  ${source.padEnd(4)} reads ${reads} (fetch ${kinds.fetch}, cited ${kinds.cited})  search hits ${kinds.search_hit}  last ${date(last)}`,
        );
      }
    });

  const sources = cmd
    .command("sources")
    .description("Local folders copied in and kept in sync until edited in ORC");
  sources
    .command("list <kb>")
    .description("List registered folders")
    .action(async (ref: string) => {
      const client = await kbClient({ project: false });
      const r = unwrap(await client.kb.sources(await resolveKb(client, ref)));
      if (isJson()) return jsonOut(r);
      if (!r.sources.length) return console.log("No folders registered.");
      for (const s of r.sources)
        console.log(
          `${s.id}  ${s.root_path}  ${s.pattern}  ${s.document_count} docs  scanned ${date(s.last_scan_at)}${s.last_error ? `  error: ${s.last_error}` : ""}`,
        );
    });
  sources
    .command("add <kb> <dir>")
    .description(
      "Register a folder; files are copied in and rescanned periodically (the folder is never written)",
    )
    .option("--pattern <glob>", "Files to include, relative glob")
    .action(async (ref: string, dir: string, opts: { pattern?: string }) => {
      const client = await kbClient({ project: false });
      const r = unwrap(
        await client.kb.addSource(await resolveKb(client, ref), {
          root_path: resolve(dir),
          ...(opts.pattern ? { pattern: opts.pattern } : {}),
        }),
      );
      if (isJson()) return jsonOut(r);
      console.log(`${r.source.id}  ${r.source.root_path}`);
      printScan(r.scan);
    });
  sources
    .command("scan <source>")
    .description("Rescan a registered folder now")
    .action(async (id: string) => {
      const client = await kbClient({ project: false });
      const scan = unwrap(await client.kb.scanSource(id));
      if (isJson()) return jsonOut(scan);
      printScan(scan);
    });
  sources
    .command("rm <source>")
    .description("Unregister a folder and remove its copies (the folder itself is untouched)")
    .action(async (id: string) => {
      const client = await kbClient({ project: false });
      unwrap(await client.kb.removeSource(id));
      console.log(`Removed ${id}`);
    });

  cmd
    .command("status")
    .description("Counts, background jobs, embeddings and parsers")
    .action(async () => {
      const client = await kbClient({ project: false });
      const s = unwrap(await client.kb.status());
      if (isJson()) return jsonOut(s);
      console.log(`root        ${s.root}`);
      console.log(
        `content     ${s.knowledge_bases} knowledge bases, ${s.documents} documents, ${s.chunks} passages`,
      );
      console.log(
        `jobs        ${s.jobs.queued} queued, ${s.jobs.running} running, ${s.jobs.failed} failed`,
      );
      const e = s.embedding;
      console.log(
        `embeddings  ${e.provider === "none" ? "off (full-text search only)" : `${e.provider} ${e.model ?? ""} ${e.ready ? "ready" : `pending ${e.pending_chunks}`} ${e.vector_backend ?? ""}`}${e.detail ? ` - ${e.detail}` : ""}`,
      );
      for (const p of s.parsers)
        console.log(
          `parser      ${p.id}@${p.version} ${p.installed ? (p.enabled ? "enabled" : "installed, disabled") : "not installed"}`,
        );
    });

  cmd
    .command("settings")
    .description("Show or change parser and embedding settings")
    .option("--parser <id>", "Default parser: auto|basic|docling")
    .addOption(
      new Option("--embedding-provider <p>", "Embeddings provider").choices([
        "none",
        "ollama",
        "openai",
      ]),
    )
    .option("--embedding-model <model>", "Embedding model")
    .option("--embedding-url <url>", "Embedding API base URL")
    .option("--embedding-key <key>", "Embedding API key ('' clears)")
    .action(
      async (opts: {
        parser?: string;
        embeddingProvider?: "none" | "ollama" | "openai";
        embeddingModel?: string;
        embeddingUrl?: string;
        embeddingKey?: string;
      }) => {
        const client = await kbClient({ project: false });
        const embedding = {
          ...(opts.embeddingProvider ? { provider: opts.embeddingProvider } : {}),
          ...(opts.embeddingModel ? { model: opts.embeddingModel } : {}),
          ...(opts.embeddingUrl ? { base_url: opts.embeddingUrl } : {}),
          ...(opts.embeddingKey !== undefined ? { api_key: opts.embeddingKey || null } : {}),
        };
        const changed = opts.parser || Object.keys(embedding).length;
        const s = unwrap(
          changed
            ? await client.kb.updateSettings({
                ...(opts.parser ? { parser: opts.parser } : {}),
                ...(Object.keys(embedding).length ? { embedding } : {}),
              })
            : await client.kb.settings(),
        );
        if (isJson()) return jsonOut(s);
        console.log(`root         ${s.root}`);
        console.log(`parser       ${s.parser}${s.docling_enabled ? " (docling enabled)" : ""}`);
        const e = s.embedding;
        console.log(
          `embedding    ${e.provider}${e.model ? ` ${e.model}` : ""}${e.base_url ? ` @ ${e.base_url}` : ""}${e.api_key_set ? " (key set)" : ""}`,
        );
        console.log(`max upload   ${Math.round(s.max_upload_bytes / 1024 / 1024)} MB`);
        if (s.env_overrides.length) console.log(`env override ${s.env_overrides.join(", ")}`);
      },
    );

  const docling = cmd.command("docling").description("Optional Docling parser (PDF layout, OCR)");
  docling
    .command("status")
    .description("Install state")
    .action(async () => {
      const client = await kbClient({ project: false });
      const r = unwrap(await client.kb.parsers());
      if (isJson()) return jsonOut(r);
      const d = r.parsers.find((p) => p.id === "docling");
      console.log(
        `docling  ${d?.installed ? `installed ${d.version}` : "not installed"}  ${r.docling.state}${r.docling.step ? ` - ${r.docling.step}` : ""}`,
      );
      if (r.docling.error) console.log(`error: ${r.docling.error}`);
    });
  docling
    .command("install")
    .description("Download and install Docling into the knowledge root (runs in the daemon)")
    .action(async () => {
      const client = await kbClient({ project: false });
      const r = unwrap(await client.kb.installDocling());
      if (isJson()) return jsonOut(r);
      console.log(`Install ${r.state}. Follow with: orc kb docling status`);
    });
  docling
    .command("remove")
    .description("Uninstall Docling; documents keep their parsed text")
    .action(async () => {
      const client = await kbClient({ project: false });
      unwrap(await client.kb.uninstallDocling());
      console.log("Docling removed.");
    });

  return cmd;
}

function printScan(s: {
  added: number;
  updated: number;
  missing: number;
  unchanged: number;
  errors: string[];
}) {
  console.log(
    `scan: ${s.added} added, ${s.updated} updated, ${s.missing} missing, ${s.unchanged} unchanged`,
  );
  for (const e of s.errors) console.log(`  ${e}`);
}

/** Hidden: parser subprocess entry for bundled and compiled builds. */
export function kbParserWorkerCommand() {
  return new Command(PARSER_WORKER_COMMAND)
    .argument("<request>")
    .action(async (request: string) => process.exit(await runParserWorker(request)));
}
