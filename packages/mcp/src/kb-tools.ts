import { ValidationError } from "@orc/core/errors";
import {
  KB_SCOPES,
  KB_SEARCH_MODES,
  type KbCallContext,
  KbDocumentCreateSchema,
  KbDocumentUpdateSchema,
} from "@orc/core/kb";
import { getKnowledgeService, parseCitation } from "@orc/knowledge";
import { z } from "zod";

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
      "Read a KB document by ID (whole or one heading's section), or one passage by citation handle. " +
      "Whole documents can be long: prefer heading or citation when you know what you need.",
    inputSchema: z.object({
      id: z.string().optional().describe("Document ID"),
      citation: z.string().optional().describe("Citation handle kb:<doc>@<rev>#<n>"),
      heading: z.string().max(300).optional().describe("Return only this section"),
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
      "replacement of one (document_id + expected_revision from your last read). Give a note saying why, and " +
      "derived_from with the document IDs a summary was built from so it is flagged when they change.",
    inputSchema: z.object({
      kb_id: z.string().optional().describe("Knowledge base for a new document"),
      document_id: z.string().optional().describe("Document to replace"),
      expected_revision: z.number().int().min(1).optional(),
      title: KbDocumentCreateSchema.shape.title.optional(),
      path: KbDocumentCreateSchema.shape.path,
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
      "Upkeep queue for a KB: stale derived documents (a source changed), failed files, wiki links to nothing.",
    inputSchema: z.object({ kb_id: z.string() }),
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
      if (!kbs.length) return "No knowledge bases. A person creates them in the ORC web UI.";
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
  }
}
