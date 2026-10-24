/**
 * Knowledge base contracts: Project or Global -> Knowledge base -> Documents.
 *
 * Browser-safe (zod + types only). The service lives in @orc/knowledge; REST, SDK, MCP, CLI
 * and the web UI are thin transports over it, so they share these shapes.
 */
import { z } from "zod";

// --- Read accounting -------------------------------------------------------------------------

/** Transport a call arrived through. Set by the transport layer; it drives read accounting and
 * which KBs the call may edit (`editable_by`). */
export const KB_CALL_SOURCES = ["mcp", "api", "cli", "ui"] as const;
export type KbCallSource = (typeof KB_CALL_SOURCES)[number];
/** `fetch` = document/section opened, `cited` = passage in an evidence pack, `search_hit` = listed only. */
export const KB_READ_KINDS = ["fetch", "cited", "search_hit"] as const;
export type KbReadKind = (typeof KB_READ_KINDS)[number];

/** Attribution only; permissions come from the call source. */
export type KbActor = {
  /** Display name/author recorded on writes ("nir", "claude", ...). */
  name?: string;
  backend?: string;
  session_id?: string;
  task_id?: string;
};

/** Who is calling and through which transport. Every service call carries one. */
export type KbCallContext = {
  source: KbCallSource;
  actor: KbActor;
  /** Active project for default scope (its KBs + global). */
  project_id?: string | null;
  /** Selected MCP projects, in priority order. Limits discovery even for scope all. */
  project_ids?: readonly string[];
};

export type KbUsageCounts = Record<KbCallSource, Record<KbReadKind, number>>;
export type KbUsageStats = {
  /** Headline reads = fetch + cited, all sources. search_hit is exposure, not usage. */
  reads: number;
  exposures: number;
  totals: KbUsageCounts;
  last_read_at: Partial<Record<KbCallSource, number>>;
  /** Within the raw-event retention window. */
  distinct_sessions: number;
  window: { days_7: number; days_30: number };
};

// --- Knowledge bases -------------------------------------------------------------------------

const nameSchema = z.string().trim().min(1).max(120);

/** Sources allowed to create, edit and delete documents in a KB; every source may read. */
const editableBySchema = z
  .array(z.enum(KB_CALL_SOURCES))
  .max(KB_CALL_SOURCES.length)
  .transform((s) => KB_CALL_SOURCES.filter((x) => s.includes(x)));

export const KbCreateSchema = z
  .object({
    name: nameSchema,
    description: z.string().trim().max(2000).default(""),
    /** Explicit: an existing project ID, or null for a deliberately global KB. */
    project_id: z.string().min(1).nullable(),
    editable_by: editableBySchema.default([...KB_CALL_SOURCES]),
    /** Parser override for this KB; null follows the workspace default/auto selection. */
    parser: z.string().min(1).max(40).nullable().default(null),
  })
  .strict();
export type KbCreate = z.input<typeof KbCreateSchema>;

export const KbUpdateSchema = z
  .object({
    name: nameSchema.optional(),
    description: z.string().trim().max(2000).optional(),
    editable_by: editableBySchema.optional(),
    parser: z.string().min(1).max(40).nullable().optional(),
  })
  .strict();
export type KbUpdate = z.input<typeof KbUpdateSchema>;

export type KnowledgeBase = {
  id: string;
  name: string;
  description: string;
  project_id: string | null;
  editable_by: KbCallSource[];
  parser: string | null;
  document_count: number;
  created_at: number;
  updated_at: number;
};

/** Default = active project's KBs plus global. `all` is a read-only view across projects. */
export const KB_SCOPES = ["default", "project", "global", "all"] as const;
export type KbScope = (typeof KB_SCOPES)[number];

// --- Documents -------------------------------------------------------------------------------

/** `authored`: Markdown content owned by orc.db revisions (editable). `upload`: immutable original
 * bytes, parsed. `external`: copied from a registered folder; ORC never writes the folder. The
 * copy follows the file on rescan until it is edited in ORC, then it is detached. */
export const KB_DOC_ORIGINS = ["authored", "upload", "external"] as const;
export type KbDocOrigin = (typeof KB_DOC_ORIGINS)[number];

export const KB_PARSE_STATES = ["pending", "ok", "partial", "failed"] as const;
export type KbParseState = (typeof KB_PARSE_STATES)[number];
export const KB_INDEX_STATES = [
  "pending",
  "lexical_ready",
  "semantic_pending",
  "semantic_ready",
  "failed",
] as const;
export type KbIndexState = (typeof KB_INDEX_STATES)[number];

/** Relative POSIX path inside a KB ("guides/setup.md"). Folders are derived from it. */
export const KbPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.includes(":") &&
      !p.includes("\0") &&
      p.split("/").every((part) => part && part !== "." && part !== ".."),
    "Use a relative path with / separators and no . or .. segments",
  );

const labelsSchema = z.array(z.string().trim().min(1).max(60)).max(30);

export const KB_MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

export const KbDocumentCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    path: KbPathSchema.optional(),
    description: z.string().trim().max(2000).optional(),
    labels: labelsSchema.default([]),
    content: z.string().max(KB_MAX_MARKDOWN_BYTES),
    note: z.string().trim().max(1000).optional(),
    /** Documents this one was derived from (agent summaries); used for staleness. */
    derived_from: z.array(z.string().min(1)).max(50).default([]),
  })
  .strict();
export type KbDocumentCreate = z.input<typeof KbDocumentCreateSchema>;

export const KbDocumentUpdateSchema = z
  .object({
    expected_revision: z.number().int().min(1),
    title: z.string().trim().min(1).max(300).optional(),
    path: KbPathSchema.optional(),
    description: z.string().trim().max(2000).optional(),
    labels: labelsSchema.optional(),
    content: z.string().max(KB_MAX_MARKDOWN_BYTES).optional(),
    note: z.string().trim().max(1000).optional(),
    derived_from: z.array(z.string().min(1)).max(50).optional(),
  })
  .strict();
export type KbDocumentUpdate = z.input<typeof KbDocumentUpdateSchema>;

export type KbParserProvenance = { id: string; version: string; options_hash: string };

export type KbDocument = {
  id: string;
  kb_id: string;
  title: string;
  description: string;
  path: string;
  labels: string[];
  origin: KbDocOrigin;
  media_type: string;
  original_name: string | null;
  size_bytes: number;
  content_hash: string;
  revision: number;
  editable: boolean;
  parse_state: KbParseState;
  index_state: KbIndexState;
  parser: KbParserProvenance | null;
  warnings: string[];
  /** External copies: `following` the folder file, or `detached` after an edit in ORC. */
  folder_sync: "following" | "detached" | null;
  /** Agent-derived documents become stale when a recorded source changes. */
  stale: boolean;
  derived_from: string[];
  created_at: number;
  updated_at: number;
  updated_by: string;
};

export type KbDocumentWithContent = KbDocument & {
  /** Authored/external Markdown, or the parser's Markdown projection for uploads. */
  content: string;
  outline: { level: number; text: string; block: number }[];
  backlinks: { document_id: string; title: string; kb_id: string }[];
  /** Outgoing links by normalized target; title is the linked document's when it resolves. */
  links: { target: string; document_id: string | null; title: string | null }[];
};

export type KbRevision = {
  document_id: string;
  revision: number;
  title: string;
  path: string;
  labels: string[];
  content_hash: string;
  note: string;
  actor: string;
  source: KbCallSource;
  session_id: string | null;
  created_at: number;
};

// --- Parsing ---------------------------------------------------------------------------------

export const PARSED_DOCUMENT_SCHEMA_VERSION = 1;

export const KB_BLOCK_KINDS = ["heading", "paragraph", "list_item", "table", "code"] as const;

export const ParsedBlockSchema = z.object({
  kind: z.enum(KB_BLOCK_KINDS),
  text: z.string(),
  level: z.number().int().min(1).max(6).optional(),
  rows: z.array(z.array(z.string())).optional(),
  heading_path: z.array(z.string()),
  /** Only what the parser really knows: page (PDF/slide), sheet, bbox. Never invented. */
  locator: z
    .object({
      page: z.number().int().min(1).optional(),
      sheet: z.string().optional(),
      bbox: z.array(z.number()).length(4).optional(),
    })
    .optional(),
});
export type ParsedBlock = z.infer<typeof ParsedBlockSchema>;

/** ORC-owned parser output. Consumers never see a parser's native types. */
export const ParsedDocumentSchema = z.object({
  schema_version: z.literal(PARSED_DOCUMENT_SCHEMA_VERSION),
  parser: z.object({
    id: z.string(),
    version: z.string(),
    options: z.record(z.string(), z.unknown()),
  }),
  source_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(["ok", "partial", "failed"]),
  language: z.string().optional(),
  blocks: z.array(ParsedBlockSchema),
  markdown: z.string(),
  warnings: z.array(z.string()),
  timings_ms: z.record(z.string(), z.number()).optional(),
  peak_rss_mb: z.number().optional(),
});
export type ParsedDocument = z.infer<typeof ParsedDocumentSchema>;

export type KbParserCapabilities = {
  /** Lowercase extensions without the dot. */
  formats: string[];
  ocr: boolean;
  tables: boolean;
  page_locators: boolean;
  bbox_locators: boolean;
};

export type KbParserInfo = {
  id: string;
  label: string;
  version: string;
  installed: boolean;
  enabled: boolean;
  capabilities: KbParserCapabilities;
  /** Installed (or download) size, for settings. */
  size_bytes: number | null;
  description: string;
  detail?: string;
};

// --- Search ----------------------------------------------------------------------------------

export const KB_SEARCH_MODES = ["auto", "lexical", "semantic", "hybrid"] as const;
export type KbSearchMode = (typeof KB_SEARCH_MODES)[number];

export const KbSearchSchema = z
  .object({
    query: z.string().trim().min(1).max(2000),
    scope: z.enum(KB_SCOPES).default("default"),
    kb_ids: z.array(z.string().min(1)).max(50).optional(),
    labels: z.array(z.string().min(1)).max(20).optional(),
    media_types: z.array(z.string().min(1)).max(20).optional(),
    mode: z.enum(KB_SEARCH_MODES).default("auto"),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict();
export type KbSearchRequest = z.input<typeof KbSearchSchema>;

export type KbPassage = {
  chunk_id: number;
  /** Stable citation handle: kb:<document>@<revision>#<chunk ordinal>. */
  citation: string;
  heading_path: string[];
  locator: ParsedBlock["locator"] | null;
  text: string;
  /** Snippet with the matched terms marked as «term». */
  snippet: string;
};

export type KbSearchHit = {
  document_id: string;
  kb_id: string;
  kb_name: string;
  title: string;
  path: string;
  revision: number;
  media_type: string;
  labels: string[];
  score: number;
  /** Which retrieval paths found it. */
  matched_by: ("exact" | "lexical" | "semantic")[];
  passages: KbPassage[];
};

export type KbSearchResult = {
  hits: KbSearchHit[];
  mode: Exclude<KbSearchMode, "auto">;
  /** Present when semantic retrieval was requested/expected but unavailable. */
  degraded?: string;
  timings_ms: Record<string, number>;
};

export const KbEvidenceSchema = KbSearchSchema.omit({ limit: true, mode: true })
  .extend({
    mode: z.enum(KB_SEARCH_MODES).default("auto"),
    /** Approximate output budget in model tokens. */
    token_budget: z.number().int().min(500).max(32000).default(6000),
    max_per_document: z.number().int().min(1).max(10).default(3),
  })
  .strict();
export type KbEvidenceRequest = z.input<typeof KbEvidenceSchema>;

export type KbEvidencePack = {
  query: string;
  mode: Exclude<KbSearchMode, "auto">;
  degraded?: string;
  token_estimate: number;
  items: (KbPassage & {
    document_id: string;
    kb_name: string;
    title: string;
    revision: number;
    derived: boolean;
  })[];
  /** Documents that matched but did not fit the budget. */
  omitted: { document_id: string; title: string }[];
  note?: string;
};

// --- Status ----------------------------------------------------------------------------------

export type KbEmbeddingStatus = {
  provider: "none" | "ollama" | "openai";
  model: string | null;
  dimensions: number | null;
  /** sqlite-vec when the extension loads; exact-scan otherwise (still exact, slower). */
  vector_backend: "sqlite-vec" | "exact-scan" | null;
  ready: boolean;
  pending_chunks: number;
  detail?: string;
};

export type KbStatus = {
  root: string;
  knowledge_bases: number;
  documents: number;
  chunks: number;
  jobs: { queued: number; running: number; failed: number };
  embedding: KbEmbeddingStatus;
  parsers: KbParserInfo[];
};

// --- Wire types shared by the API, SDK, CLI and web ------------------------------------------

export type KbDocumentListing = {
  documents: (KbDocument & { reads: number; reads_by_source: Record<string, number> })[];
  folders: string[];
  labels: { label: string; count: number }[];
};

/** A registered local folder whose files are copied into the KB; ORC never writes it. */
export type KbSource = {
  id: string;
  kb_id: string;
  root_path: string;
  pattern: string;
  last_scan_at: number | null;
  last_error: string | null;
  created_at: number;
  /** Copies in the KB, following and edited. */
  document_count: number;
  /** Copies edited in ORC: they no longer follow their file and are kept when syncing stops. */
  edited_count: number;
};

export type KbSourceScan = {
  added: number;
  updated: number;
  missing: number;
  unchanged: number;
  errors: string[];
};

export type KbMaintenanceQueue = {
  stale: KbDocument[];
  failed: KbDocument[];
  unresolved_links: { target: string; document_id: string; title: string }[];
};

export type KbDoclingState = {
  state: "idle" | "installing" | "failed";
  step?: string;
  log: string[];
  error?: string;
  started_at?: number;
};

export type KbEmbeddingSettings = {
  provider: KbEmbeddingStatus["provider"];
  base_url?: string;
  model?: string;
  dimensions?: number;
  batch_size: number;
  timeout_secs: number;
  api_key_set: boolean;
};

/** GET /api/kb/settings. API keys are never returned. */
export type KbSettings = {
  session_embeddings: boolean;
  root: string;
  parser: string;
  docling_enabled: boolean;
  parser_timeout_secs: number;
  max_upload_bytes: number;
  usage_retention_days: number;
  embedding: KbEmbeddingSettings;
  /** ORC_KNOWLEDGE_* environment variables, which override saved settings. */
  env_overrides: string[];
};

export type KbSettingsPatch = Partial<
  Omit<KbSettings, "root" | "embedding" | "env_overrides"> & {
    embedding: Partial<{
      provider: KbEmbeddingSettings["provider"];
      base_url: string | null;
      model: string | null;
      dimensions: number | null;
      /** A string sets the key, null clears it, absent keeps it. */
      api_key: string | null;
      batch_size: number;
      timeout_secs: number;
    }>;
  }
>;

// --- Partial document edits ------------------------------------------------------------------

/** Exact text replacement. `old` must match once unless `replace_all`. */
export const KbTextEditSchema = z
  .object({
    old: z.string().min(1).max(KB_MAX_MARKDOWN_BYTES),
    new: z.string().max(KB_MAX_MARKDOWN_BYTES),
    replace_all: z.boolean().optional(),
  })
  .strict();

/** Replaces lines start_line..end_line (1-based, inclusive). Empty `new` deletes them;
 * start_line = end_line + 1 inserts before start_line. */
export const KbLineEditSchema = z
  .object({
    start_line: z.number().int().min(1),
    end_line: z.number().int().min(0),
    new: z.string().max(KB_MAX_MARKDOWN_BYTES),
  })
  .strict();

export const KbDocumentEditSchema = z
  .object({
    /** Line numbers in line edits refer to this revision. */
    expected_revision: z.number().int().min(1),
    edits: z
      .array(z.union([KbTextEditSchema, KbLineEditSchema]))
      .min(1)
      .max(50),
    note: z.string().trim().min(1).max(1000),
  })
  .strict();
export type KbDocumentEdit = z.input<typeof KbDocumentEditSchema>;

export type KbDocumentEditResult = {
  document: KbDocument;
  /** Line ranges of the new revision that each edit wrote, in edit order. */
  changed: { start_line: number; end_line: number }[];
};

// --- Comments --------------------------------------------------------------------------------

export const KB_COMMENT_STATUSES = ["open", "resolved", "dismissed"] as const;
export type KbCommentStatus = (typeof KB_COMMENT_STATUSES)[number];
/** Comments per status, for a knowledge base or one of its documents. */
export type KbCommentCounts = Record<KbCommentStatus, number>;

export const KbCommentCreateSchema = z
  .object({
    /** Omit (or null) for a comment on the whole knowledge base. */
    document_id: z.string().min(1).nullable().optional(),
    body: z.string().trim().min(1).max(10_000),
  })
  .strict();
export type KbCommentCreate = z.input<typeof KbCommentCreateSchema>;

export const KbCommentCloseSchema = z
  .object({
    status: z.enum(["resolved", "dismissed"]),
    reply: z.string().trim().min(1).max(4000),
  })
  .strict();
export type KbCommentClose = z.input<typeof KbCommentCloseSchema>;

export type KbComment = {
  id: string;
  kb_id: string;
  document_id: string | null;
  /** Title of the commented document when it still exists. */
  document_title: string | null;
  body: string;
  author: string;
  source: KbCallSource;
  session_id: string | null;
  status: KbCommentStatus;
  reply: string | null;
  resolved_by: string | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
};

// --- Digests ---------------------------------------------------------------------------------

/** A digest runs either on a cron schedule or only when started by hand. */
export const KbDigestScheduleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cron"), cron: z.string().trim().min(1).max(120) }).strict(),
  z.object({ type: z.literal("manual") }).strict(),
]);
export type KbDigestSchedule = z.infer<typeof KbDigestScheduleSchema>;

export const KbDigestSetSchema = z
  .object({
    instructions: z.string().trim().min(1).max(20_000).optional(),
    backend: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]*$/)
      .optional(),
    schedule: KbDigestScheduleSchema.optional(),
    enabled: z.boolean().optional(),
    timeout_secs: z.number().int().min(60).max(7200).optional(),
  })
  .strict();
export type KbDigestSet = z.input<typeof KbDigestSetSchema>;

export const KB_DIGEST_RUN_STATUSES = ["running", "completed", "failed", "skipped"] as const;
export type KbDigestRunStatus = (typeof KB_DIGEST_RUN_STATUSES)[number];

export type KbDigest = {
  kb_id: string;
  instructions: string;
  backend: string;
  job_id: string;
  schedule: KbDigestSchedule;
  enabled: boolean;
  timeout_secs: number;
  /** Start of the last run that completed; the next run looks at what happened since. */
  last_success_at: number | null;
  last_run: {
    status: KbDigestRunStatus;
    at: number;
    note: string | null;
    session_id: string | null;
  } | null;
  /** Next scheduled start (ms) for an enabled cron digest, in the daemon's time zone; else null. */
  next_run_at: number | null;
  open_comments: number;
  created_at: number;
  updated_at: number;
};

export type KbDigestRun = {
  run_id: string;
  status: string;
  trigger_by: string | null;
  /** Epoch milliseconds, like every other KB time. */
  started_at: number | null;
  ended_at: number | null;
  summary: string | null;
  error: string | null;
  session_id: string | null;
};

export const KB_DIGEST_DEFAULT_CRON = "0 3 * * *";

/** Starter instructions offered when a digest is added; the owner edits them freely. */
export const KB_DIGEST_TEMPLATE = `Keep this knowledge base an accurate, current record of what has been learned in its scope.

1. Handle every open comment first. Do what it asks when it is right; then resolve it with a short reply saying what you changed, or dismiss it with the reason.
2. Read what happened since the last run with ORC tools: new and changed memories (memory_list, memory_read), session summaries, and the audit log (audit_list).
3. Turn durable lessons into documents: decisions and their reasons, pitfalls and fixes, how things work, conventions. Skip one-off status and anything already recorded.
4. Before writing, search this knowledge base (kb_search). Update the existing document instead of creating a near-duplicate; merge duplicates you find.
5. When a memory, comment or document links to a source (URL, file, document), read it and write a digested document that cites the source.
6. Correct documents that new evidence shows are wrong, and remove documents that are obsolete.
7. Edit long documents with kb_document action "edit" (changed lines only); use kb_write for new documents and full rewrites. Give every write a note saying why.
8. Keep each document focused on one topic, with a clear title, a one-line description and labels. Link related documents with [[path-or-title]].

Never store secrets, credentials or personal data.`;
