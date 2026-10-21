import { ValidationError } from "@orc/core/errors";
import {
  KB_COMMENT_STATUSES,
  KB_SCOPES,
  KB_SEARCH_MODES,
  type KbCallContext,
  type KbComment,
  KbCommentCloseSchema,
  KbCommentCreateSchema,
  type KbCommentStatus,
  KbCreateSchema,
  type KbDigest,
  type KbDigestSchedule,
  type KbDigestSet,
  KbDigestSetSchema,
  KbDocumentCreateSchema,
  type KbDocumentEdit,
  KbDocumentEditSchema,
  KbDocumentUpdateSchema,
  KbUpdateSchema,
} from "@orc/core/kb";
import { getKnowledgeService, parseCitation } from "@orc/knowledge";
import { z } from "zod";
import { orcApi } from "./api-client.js";

const projectParam = z
  .string()
  .optional()
  .describe("Project name. Defaults to activeProject; its KBs plus global ones are searched.");
const sessionParam = z
  .string()
  .optional()
  .describe("Your session ID, for read accounting (defaults to ORC_SESSION_ID)");
const filterParams = {
  project: projectParam,
  scope: z
    .enum(KB_SCOPES)
    .optional()
    .describe("default = project + global; project/global only; all = every project (read-only)"),
  kb_ids: z.array(z.string()).max(50).optional().describe("Restrict to these knowledge bases"),
  labels: z.array(z.string()).max(20).optional(),
  mode: z.enum(KB_SEARCH_MODES).optional().describe("auto uses vectors when embeddings are ready"),
  session_id: sessionParam,
};

export const kbToolDefinitions = [
  {
    name: "kb_list",
    description:
      "List knowledge bases visible from the project (its KBs + global) with document counts, whether you may edit them, and IDs.",
    inputSchema: z.object({
      project: projectParam,
      scope: z.enum(KB_SCOPES).optional(),
    }),
  },
  {
    name: "kb_search",
    description:
      "Search KB documents (exact title/path, full-text and vectors, fused). Returns documents with short passages and " +
      "citation handles kb:<doc>@<rev>#<n>. Read more with kb_read; for an answer-ready pack use kb_evidence.",
    inputSchema: z.object({
      query: z.string().min(1).max(2000),
      ...filterParams,
      limit: z.number().int().min(1).max(20).optional().default(8),
    }),
  },
  {
    name: "kb_evidence",
    description:
      "Budgeted evidence pack for answering a question: cited passages from several documents (agent-written summaries " +
      "are flagged as derived, not independent corroboration). Cite the handles in your answer.",
    inputSchema: z.object({
      query: z.string().min(1).max(2000),
      ...filterParams,
      token_budget: z.number().int().min(500).max(16000).optional().default(6000),
    }),
  },
  {
    name: "kb_read",
    description:
      "Read a KB document by ID (whole, one heading's section, or a numbered line range), or one passage by " +
      "citation handle. Whole documents can be long: prefer heading, lines or citation when you know what you " +
      "need. Read numbered lines before a line edit (kb_document action edit).",
    inputSchema: z.object({
      id: z.string().optional().describe("Document ID"),
      citation: z.string().optional().describe("Citation handle kb:<doc>@<rev>#<n>"),
      heading: z.string().max(300).optional().describe("Return only this section"),
      start_line: z.number().int().min(1).optional().describe("Numbered lines from here"),
      end_line: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Numbered lines up to here (inclusive)"),
      session_id: sessionParam,
    }),
  },
  {
    name: "kb_documents",
    description:
      "List documents in a knowledge base (title, path, labels, revision, state, reads).",
    inputSchema: z.object({
      kb_id: z.string(),
      folder: z.string().optional(),
      label: z.string().optional(),
    }),
  },
  {
    name: "kb_write",
    description:
      "Write Markdown to a KB you may edit (kb_list shows which): a new document (kb_id + title) or a full " +
      "replacement of one (document_id + expected_revision from your last read). For a few changes in a long " +
      "document use kb_document action edit instead. Give a note saying why, and derived_from with the " +
      "document IDs a summary was built from so it is flagged when they change.",
    inputSchema: z.object({
      kb_id: z.string().optional().describe("Knowledge base for a new document"),
      document_id: z.string().optional().describe("Document to replace"),
      expected_revision: z.number().int().min(1).optional(),
      title: KbDocumentCreateSchema.shape.title.optional(),
      path: KbDocumentCreateSchema.shape.path
        .unwrap()
        .regex(/\.[mM](?:[dD]|[aA][rR][kK][dD][oO][wW][nN])$/, "Use a .md or .markdown path")
        .optional()
        .describe(
          "Relative Markdown path ending in .md or .markdown (case-insensitive). For new documents, omit to generate from title.",
        ),
      description: KbDocumentCreateSchema.shape.description,
      labels: KbDocumentUpdateSchema.shape.labels,
      content: KbDocumentCreateSchema.shape.content,
      note: z.string().trim().min(1).max(1000),
      derived_from: KbDocumentUpdateSchema.shape.derived_from,
      session_id: sessionParam,
    }),
  },
  {
    name: "kb_maintenance",
    description:
      "Upkeep queue for a KB: stale derived documents (a source changed), failed files, links to missing documents.",
    inputSchema: z.object({ kb_id: z.string() }),
  },
  {
    name: "kb_manage",
    description:
      "Create, update or delete a knowledge base. create: name (+ description) in the project, or global:true. " +
      "update/delete need a KB that allows mcp (kb_list shows editable). delete removes every document and the " +
      "digest; pass confirm = the KB's exact name.",
    inputSchema: z.object({
      action: z.enum(["create", "update", "delete"]),
      kb_id: z.string().optional().describe("For update and delete"),
      name: KbCreateSchema.shape.name.optional(),
      description: KbUpdateSchema.shape.description,
      global: z.boolean().optional().describe("create: a KB for every project instead of this one"),
      confirm: z.string().optional().describe("delete: the KB's exact name"),
      project: projectParam,
    }),
  },
  {
    name: "kb_document",
    description:
      "Change one KB document. edit: partial edits of a long document, each {old, new[, replace_all]} for exact " +
      "text or {start_line, end_line, new} for whole lines (end_line = start_line - 1 inserts); all edits refer to " +
      "expected_revision as read (kb_read with start_line/end_line shows numbered lines), so later edits never " +
      "shift. update: title, path (move), description or labels. history: revisions. restore: bring back a past " +
      "revision. delete: remove the document. Pass document_id (or its legacy alias id).",
    inputSchema: z.object({
      action: z.enum(["edit", "update", "history", "restore", "delete"]),
      document_id: z
        .string()
        .min(1)
        .optional()
        .describe("Document ID; required unless id is supplied"),
      id: z
        .string()
        .min(1)
        .optional()
        .describe("Legacy alias for document_id; must match if both are supplied"),
      expected_revision: z.number().int().min(1).optional().describe("edit, update, restore"),
      edits: KbDocumentEditSchema.shape.edits.optional(),
      title: KbDocumentUpdateSchema.shape.title,
      path: KbDocumentUpdateSchema.shape.path,
      description: KbDocumentUpdateSchema.shape.description,
      labels: KbDocumentUpdateSchema.shape.labels,
      revision: z.number().int().min(1).optional().describe("restore: the revision to bring back"),
      note: z.string().trim().min(1).max(1000).optional().describe("Why; required for edit"),
      session_id: sessionParam,
    }),
  },
  {
    name: "kb_comment",
    description:
      "Comments on a KB or one of its documents: requests, corrections, sources to digest. Anyone may add one; " +
      "the digest handles open comments first. resolve/dismiss close a comment with one reply saying what was " +
      "done or why not (needs a KB that allows mcp).",
    inputSchema: z.object({
      action: z.enum(["add", "list", "resolve", "dismiss", "reopen"]),
      kb_id: z.string().optional().describe("add, list"),
      document_id: z
        .string()
        .optional()
        .describe("add: comment on this document; list: only its comments"),
      body: KbCommentCreateSchema.shape.body.optional(),
      comment_id: z.string().optional().describe("resolve, dismiss, reopen"),
      reply: KbCommentCloseSchema.shape.reply.optional(),
      status: z.enum(KB_COMMENT_STATUSES).optional().describe("list filter"),
      limit: z.number().int().min(1).max(200).optional(),
      session_id: sessionParam,
    }),
  },
  {
    name: "kb_digest",
    description:
      "The digest keeps a KB current: an agent runs its instructions on a schedule (an ORC job). get: settings and " +
      "last run. template: starter instructions. set: create or change instructions, backend (claude, codex, ...), " +
      "schedule {type:cron, cron} or {type:manual}, enabled. run: start now. runs: history. delete: remove the " +
      "digest and its job (confirm = the KB's exact name).",
    inputSchema: z.object({
      action: z.enum(["get", "template", "set", "run", "runs", "delete"]),
      kb_id: z.string().optional().describe("Every action but template"),
      instructions: KbDigestSetSchema.shape.instructions,
      backend: KbDigestSetSchema.shape.backend,
      schedule: KbDigestSetSchema.shape.schedule,
      enabled: KbDigestSetSchema.shape.enabled,
      timeout_secs: KbDigestSetSchema.shape.timeout_secs,
      confirm: z.string().optional().describe("delete: the KB's exact name"),
      limit: z.number().int().min(1).max(100).optional(),
    }),
  },
] as const;

export type KbToolName = (typeof kbToolDefinitions)[number]["name"];

export const isKbTool = (name: string): name is KbToolName =>
  kbToolDefinitions.some((t) => t.name === name);

function context(projectId: string | null, sessionId?: string): KbCallContext {
  const session = sessionId ?? process.env.ORC_SESSION_ID;
  const name = [process.env.ORC_AGENT, process.env.CLAUDE_MODEL].filter(Boolean).join("/");
  return {
    source: "mcp",
    actor: {
      ...(name ? { name } : {}),
      ...(process.env.ORC_AGENT ? { backend: process.env.ORC_AGENT } : {}),
      ...(session ? { session_id: session } : {}),
    },
    project_id: projectId,
  };
}

const scopeOf = (kb: { project_id: string | null }) => (kb.project_id ? "project" : "global");

type Args = Record<string, unknown>;

function filters(a: Args) {
  return {
    ...(a.scope ? { scope: a.scope as (typeof KB_SCOPES)[number] } : {}),
    ...(a.kb_ids ? { kb_ids: a.kb_ids as string[] } : {}),
    ...(a.labels ? { labels: a.labels as string[] } : {}),
    ...(a.mode ? { mode: a.mode as (typeof KB_SEARCH_MODES)[number] } : {}),
  };
}

/** Compact KB search lines for the general `search` tool. */
export async function kbSearchLines(query: string, projectId: string | null, limit: number) {
  const svc = await getKnowledgeService();
  const result = await svc.search(context(projectId), { query, limit });
  return result.hits.map(
    (h) =>
      `  [kb] ${h.document_id} [${h.kb_name}] ${h.title}: ${h.passages[0]?.snippet.replace(/\s+/g, " ").slice(0, 160) ?? ""}`,
  );
}

export async function executeKbTool(
  name: KbToolName,
  args: Args,
  projectId: string | null,
): Promise<string> {
  const svc = await getKnowledgeService();
  const ctx = context(projectId, args.session_id as string | undefined);
  switch (name) {
    case "kb_list": {
      const kbs = svc.listKbs(ctx, (args.scope as (typeof KB_SCOPES)[number]) ?? "default");
      if (!kbs.length) return "No knowledge bases. Create one with kb_manage action create.";
      return kbs
        .map(
          (kb) =>
            `${kb.id}  ${kb.name} [${scopeOf(kb)}] ${kb.document_count} docs` +
            (kb.editable_by.includes("mcp") ? " editable" : " read-only") +
            (kb.description ? ` - ${kb.description}` : ""),
        )
        .join("\n");
    }
    case "kb_search": {
      const r = await svc.search(ctx, {
        query: args.query as string,
        limit: (args.limit as number) ?? 8,
        ...filters(args),
      });
      if (!r.hits.length) return `No KB documents matched (${r.mode}).`;
      const lines = [
        `${r.hits.length} documents (${r.mode})${r.degraded ? ` - ${r.degraded}` : ""}:`,
      ];
      for (const h of r.hits) {
        lines.push(
          `- ${h.title} (${h.path}) id:${h.document_id} rev:${h.revision} kb:${h.kb_name} via ${h.matched_by.join("+")}`,
        );
        for (const p of h.passages.slice(0, 2)) {
          const where = [p.heading_path.join(" > "), p.locator?.page ? `p.${p.locator.page}` : ""]
            .filter(Boolean)
            .join(" ");
          lines.push(
            `    ${p.citation}${where ? ` (${where})` : ""}: ${p.snippet.replace(/\s+/g, " ")}`,
          );
        }
      }
      return lines.join("\n");
    }
    case "kb_evidence": {
      const pack = await svc.evidence(ctx, {
        query: args.query as string,
        token_budget: (args.token_budget as number) ?? 6000,
        ...filters(args),
      });
      if (!pack.items.length) return pack.note ?? "No evidence found in the knowledge bases.";
      const out = [
        `Evidence for "${pack.query}" (${pack.mode}, ~${pack.token_estimate} tokens)${pack.degraded ? ` - ${pack.degraded}` : ""}`,
      ];
      for (const i of pack.items) {
        const where = [i.heading_path.join(" > "), i.locator?.page ? `p.${i.locator.page}` : ""]
          .filter(Boolean)
          .join(" ");
        out.push(
          "",
          `[${i.citation}] ${i.title} rev ${i.revision}${where ? ` - ${where}` : ""}${i.derived ? " (agent-derived summary)" : ""}`,
          i.text,
        );
      }
      if (pack.omitted.length)
        out.push(
          "",
          `Also matched (not included): ${pack.omitted.map((o) => `${o.title} ${o.document_id}`).join("; ")}`,
        );
      if (pack.note) out.push("", pack.note);
      return out.join("\n");
    }
    case "kb_read": {
      if (args.citation) {
        const cite = parseCitation(args.citation as string);
        if (!cite) return "Citation must look like kb:<document>@<revision>#<n>";
        const d = svc.readCitation(ctx, cite.document_id, cite.revision, cite.ordinal);
        return `${args.citation} - ${d.title} rev ${d.revision}\n\n${d.content}`;
      }
      if (!args.id) return "Pass id or citation.";
      if (args.start_line || args.end_line) {
        const r = svc.readLines(
          ctx,
          args.id as string,
          (args.start_line as number | undefined) ?? 1,
          args.end_line as number | undefined,
        );
        const range =
          r.end_line < r.start_line
            ? `no lines (the document has ${r.total_lines})`
            : `lines ${r.start_line}-${r.end_line} of ${r.total_lines}`;
        return `${r.title} (${r.path}) id:${r.id} rev:${r.revision} - ${range}\n\n${r.text}`;
      }
      const d = svc.getDocument(ctx, args.id as string, {
        ...(args.heading ? { heading: args.heading as string } : {}),
      });
      const head = [
        `${d.title} (${d.path}) id:${d.id} rev:${d.revision} kb:${d.kb_id}`,
        d.labels.length ? `labels: ${d.labels.join(", ")}` : "",
        d.stale ? "STALE: a source this was derived from has changed" : "",
        d.warnings.length ? `warnings: ${d.warnings.join("; ")}` : "",
        !args.heading && d.outline.length > 3
          ? `outline: ${d.outline.map((o) => `${"#".repeat(o.level)} ${o.text}`).join(" | ")}`
          : "",
        d.backlinks.length ? `linked from: ${d.backlinks.map((b) => b.title).join(", ")}` : "",
      ].filter(Boolean);
      return `${head.join("\n")}\n\n${d.content}`;
    }
    case "kb_documents": {
      const list = svc.listDocuments(args.kb_id as string, {
        ...(args.folder ? { folder: args.folder as string } : {}),
        ...(args.label ? { label: args.label as string } : {}),
      });
      if (!list.documents.length) return "No documents.";
      return list.documents
        .map(
          (d) =>
            `${d.id}  ${d.path}  "${d.title}" rev:${d.revision} ${d.index_state}${d.stale ? " STALE" : ""}` +
            (d.labels.length ? ` [${d.labels.join(", ")}]` : "") +
            ` reads:${d.reads}`,
        )
        .join("\n");
    }
    case "kb_write": {
      const optional = {
        ...(args.path ? { path: args.path as string } : {}),
        ...(args.labels ? { labels: args.labels as string[] } : {}),
        ...(args.description !== undefined ? { description: args.description as string } : {}),
        ...(args.derived_from ? { derived_from: args.derived_from as string[] } : {}),
      };
      const fields = { content: args.content as string, note: args.note as string, ...optional };
      if (args.document_id) {
        if (!args.expected_revision)
          throw new ValidationError("expected_revision is required to replace a document");
        const d = svc.updateDocument(ctx, args.document_id as string, {
          expected_revision: args.expected_revision as number,
          ...(args.title ? { title: args.title as string } : {}),
          ...fields,
        });
        return `Updated ${d.id} "${d.title}" to revision ${d.revision}.`;
      }
      if (!args.kb_id || !args.title)
        throw new ValidationError("A new document needs kb_id and title");
      const d = svc.createDocument(ctx, args.kb_id as string, {
        title: args.title as string,
        ...fields,
      });
      return `Created ${d.id} "${d.title}" at ${d.path} (revision 1).`;
    }
    case "kb_maintenance": {
      const q = svc.maintenanceQueue(args.kb_id as string);
      const lines: string[] = [];
      if (q.stale.length)
        lines.push(
          "Stale (refresh from sources):",
          ...q.stale.map(
            (d) => `  ${d.id} ${d.title} rev:${d.revision} from:${d.derived_from.join(",")}`,
          ),
        );
      if (q.failed.length)
        lines.push(
          "Failed:",
          ...q.failed.map((d) => `  ${d.id} ${d.title}: ${d.warnings.join("; ")}`),
        );
      if (q.unresolved_links.length)
        lines.push(
          "Links to missing documents:",
          ...q.unresolved_links.map((l) => `  [[${l.target}]] in ${l.title} (${l.document_id})`),
        );
      return lines.length ? lines.join("\n") : "Nothing to maintain.";
    }
    case "kb_manage": {
      const action = args.action as "create" | "update" | "delete";
      if (action === "create") {
        if (!args.name) throw new ValidationError("create needs name");
        if (!args.global && !projectId)
          throw new ValidationError(
            "Pass project, or global:true for a KB shared by every project",
          );
        const kb = svc.createKb(ctx, {
          name: args.name as string,
          project_id: args.global ? null : projectId,
          ...(args.description !== undefined ? { description: args.description as string } : {}),
        });
        return `Created knowledge base ${kb.id} "${kb.name}" [${scopeOf(kb)}].`;
      }
      const kbId = need(args, "kb_id", action);
      if (action === "update") {
        const kb = svc.updateKb(ctx, kbId, {
          ...(args.name ? { name: args.name as string } : {}),
          ...(args.description !== undefined ? { description: args.description as string } : {}),
        });
        return `Updated knowledge base ${kb.id} "${kb.name}".`;
      }
      const kb = svc.getKb(kbId);
      svc.deleteKb(ctx, kbId, confirmOf(args));
      return `Deleted knowledge base ${kbId} "${kb.name}".`;
    }
    case "kb_document": {
      if (args.document_id !== undefined && args.id !== undefined && args.document_id !== args.id)
        throw new ValidationError("document_id and id must match when both are supplied");
      const id = need({ document_id: args.document_id ?? args.id }, "document_id", "kb_document");
      switch (args.action as "edit" | "update" | "history" | "restore" | "delete") {
        case "edit": {
          const { document: d, changed } = svc.editDocument(ctx, id, {
            expected_revision: needRevision(args),
            edits: (args.edits as KbDocumentEdit["edits"] | undefined) ?? [],
            note: (args.note as string | undefined) ?? "",
          });
          const ranges = changed.map((r, i) =>
            r.end_line < r.start_line
              ? `${i + 1}: removed at line ${r.start_line}`
              : `${i + 1}: lines ${r.start_line}-${r.end_line}`,
          );
          return `Edited ${d.id} "${d.title}" to revision ${d.revision}. New text per edit: ${ranges.join("; ")}.`;
        }
        case "update": {
          const d = svc.updateDocument(ctx, id, {
            expected_revision: needRevision(args),
            ...(args.title ? { title: args.title as string } : {}),
            ...(args.path ? { path: args.path as string } : {}),
            ...(args.description !== undefined ? { description: args.description as string } : {}),
            ...(args.labels ? { labels: args.labels as string[] } : {}),
            ...(args.note ? { note: args.note as string } : {}),
          });
          return `Updated ${d.id} "${d.title}" at ${d.path} (revision ${d.revision}).`;
        }
        case "history": {
          const revs = svc.revisions(id);
          return revs
            .map(
              (r) =>
                `rev ${r.revision}  ${new Date(r.created_at).toISOString()}  ${r.actor} (${r.source})` +
                `  "${r.title}"${r.note ? ` - ${r.note}` : ""}`,
            )
            .join("\n");
        }
        case "restore": {
          if (!args.revision) throw new ValidationError("restore needs revision");
          const d = svc.restoreRevision(
            ctx,
            id,
            args.revision as number,
            needRevision(args),
            args.note as string | undefined,
          );
          return `Restored ${d.id} to the content of revision ${args.revision} as revision ${d.revision}.`;
        }
        case "delete": {
          const d = svc.getDocument(ctx, id, { record: false });
          svc.deleteDocument(ctx, id);
          return `Deleted ${id} "${d.title}".`;
        }
      }
      break;
    }
    case "kb_comment": {
      const action = args.action as "add" | "list" | "resolve" | "dismiss" | "reopen";
      if (action === "add") {
        const c = svc.addComment(ctx, need(args, "kb_id", action), {
          body: (args.body as string | undefined) ?? "",
          ...(args.document_id ? { document_id: args.document_id as string } : {}),
        });
        return `Added comment ${c.id}${c.document_title ? ` on "${c.document_title}"` : ""}.`;
      }
      if (action === "list") {
        const kbId = need(args, "kb_id", action);
        const documentId = args.document_id as string | undefined;
        const list = svc.listComments(kbId, {
          document_id: documentId,
          status: args.status as KbCommentStatus | undefined,
          limit: args.limit as number | undefined,
        });
        const n = svc.commentCounts(kbId, documentId);
        const counts = `${n.open} open · ${n.resolved} resolved · ${n.dismissed} dismissed`;
        if (!list.length) return `No matching comments (${counts}).`;
        return `${counts}\n\n${list.map(commentText).join("\n\n")}`;
      }
      const id = need(args, "comment_id", action);
      const c =
        action === "reopen"
          ? svc.reopenComment(ctx, id)
          : svc.closeComment(ctx, id, {
              status: action === "resolve" ? "resolved" : "dismissed",
              reply: (args.reply as string | undefined) ?? "",
            });
      return `Comment ${c.id} is ${c.status}.`;
    }
    case "kb_digest": {
      const action = args.action as "get" | "template" | "set" | "run" | "runs" | "delete";
      if (action === "template") return svc.digestTemplate();
      const kbId = need(args, "kb_id", action);
      // Scheduling and starting runs belong to the daemon. Inside it (MCP over HTTP) the service
      // has job hooks; a stdio MCP process asks the daemon's API instead.
      const daemon = svc.jobHooks !== null;
      switch (action) {
        case "get": {
          const d = svc.getDigest(kbId);
          return d ? digestText(d) : "No digest. Create one with action set.";
        }
        case "runs": {
          const runs = svc.digestRuns(kbId, (args.limit as number | undefined) ?? 20);
          if (!runs.length) return "No runs yet.";
          return runs
            .map(
              (r) =>
                `${r.run_id}  ${r.status}  ${r.started_at ? new Date(r.started_at * 1000).toISOString() : "-"}` +
                `  by:${r.trigger_by ?? "-"}${r.session_id ? ` session:${r.session_id}` : ""}` +
                (r.summary || r.error ? `\n    ${(r.error ?? r.summary ?? "").slice(0, 300)}` : ""),
            )
            .join("\n");
        }
        case "set": {
          const input: KbDigestSet = {
            ...(args.instructions ? { instructions: args.instructions as string } : {}),
            ...(args.backend ? { backend: args.backend as string } : {}),
            ...(args.schedule ? { schedule: args.schedule as KbDigestSchedule } : {}),
            ...(args.enabled !== undefined ? { enabled: args.enabled as boolean } : {}),
            ...(args.timeout_secs ? { timeout_secs: args.timeout_secs as number } : {}),
          };
          const d = daemon
            ? svc.setDigest(ctx, kbId, input)
            : await orcApi<KbDigest>("PUT", `/kb/bases/${enc(kbId)}/digest`, {
                body: input,
                headers: apiHeaders(ctx),
              });
          return `Digest saved.\n${digestText(d)}`;
        }
        case "run": {
          const { run_id } = daemon
            ? await svc.runDigest(ctx, kbId)
            : await orcApi<{ run_id: string }>("POST", `/kb/bases/${enc(kbId)}/digest/run`, {
                headers: apiHeaders(ctx),
              });
          return `Digest run ${run_id} started. Follow it with action runs.`;
        }
        case "delete": {
          if (daemon) svc.deleteDigest(ctx, kbId, confirmOf(args));
          else
            await orcApi("DELETE", `/kb/bases/${enc(kbId)}/digest${confirmQuery(args)}`, {
              headers: apiHeaders(ctx),
            });
          return "Digest and its job deleted.";
        }
      }
      break;
    }
  }
  throw new ValidationError(`Unknown action for ${name}`);
}

function need(a: Args, key: string, action: string): string {
  const v = a[key];
  if (typeof v !== "string" || !v) throw new ValidationError(`${action} needs ${key}`);
  return v;
}

function needRevision(a: Args): number {
  if (!a.expected_revision)
    throw new ValidationError("expected_revision is required (the revision you last read)");
  return a.expected_revision as number;
}

const confirmOf = (a: Args) => (a.confirm ? { confirm: a.confirm as string } : {});
const confirmQuery = (a: Args) =>
  a.confirm ? `?confirm=${encodeURIComponent(a.confirm as string)}` : "";
const enc = encodeURIComponent;

/** Identifies this MCP caller to the API, so it applies the same rules and attribution. */
function apiHeaders(ctx: KbCallContext): Record<string, string> {
  return {
    "X-Orc-Source": "mcp",
    ...(ctx.actor.name ? { "X-Orc-Actor-Name": ctx.actor.name } : {}),
    ...(ctx.actor.backend ? { "X-Orc-Actor-Backend": ctx.actor.backend } : {}),
    ...(ctx.actor.session_id ? { "X-Orc-Session-Id": ctx.actor.session_id } : {}),
    ...(ctx.project_id ? { "X-Orc-Project-Id": ctx.project_id } : {}),
  };
}

function commentText(c: KbComment): string {
  const on = c.document_id ? ` on "${c.document_title ?? c.document_id}" (${c.document_id})` : "";
  const head = `${c.id} [${c.status}] ${c.author} via ${c.source}${on} ${new Date(c.created_at).toISOString()}`;
  const reply = c.reply ? `\n  -> ${c.resolved_by ?? "?"}: ${c.reply}` : "";
  return `${head}\n  ${c.body.replace(/\n/g, "\n  ")}${reply}`;
}

function digestText(d: KbDigest): string {
  const when = d.schedule.type === "cron" ? `cron "${d.schedule.cron}"` : "manual";
  const last = d.last_run
    ? `${d.last_run.status} ${new Date(d.last_run.at).toISOString()}${d.last_run.note ? ` - ${d.last_run.note}` : ""}`
    : "never";
  return [
    `backend: ${d.backend}  schedule: ${when}  ${d.enabled ? "enabled" : "disabled"}  timeout: ${d.timeout_secs}s  job: ${d.job_id}`,
    `last run: ${last}`,
    `last success: ${d.last_success_at ? new Date(d.last_success_at).toISOString() : "never"}`,
    `open comments: ${d.open_comments}`,
    "",
    "Instructions:",
    d.instructions,
  ].join("\n");
}
