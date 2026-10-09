import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const evidence_sources = sqliteTable(
  "evidence_sources",
  {
    kind: text("kind").notNull(),
    source_id: text("source_id").notNull(),
    current_version: text("current_version").notNull(),
    project_id: text("project_id"),
    valid_until: integer("valid_until"),
    active: integer("active").notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.source_id] }),
    index("evidence_source_scope").on(t.project_id, t.active, t.valid_until),
  ],
);
export const evidence_versions = sqliteTable(
  "evidence_versions",
  {
    kind: text("kind").notNull(),
    source_id: text("source_id").notNull(),
    version: text("version").notNull(),
    payload: text("payload").notNull(),
    created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => [primaryKey({ columns: [t.kind, t.source_id, t.version] })],
);
export const evidence_passages = sqliteTable(
  "evidence_passages",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    source_id: text("source_id").notNull(),
    version: text("version").notNull(),
    ordinal: integer("ordinal").notNull(),
    payload: text("payload").notNull(),
    content: text("content").notNull(),
    title: text("title").notNull(),
    tags: text("tags").notNull(),
    context: text("context").notNull(),
  },
  (t) => [index("evidence_passage_source").on(t.kind, t.source_id, t.version, t.ordinal)],
);
export const evidence_embeddings = sqliteTable(
  "evidence_embeddings",
  {
    passage_id: text("passage_id").notNull(),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    vector: text("vector").notNull(),
  },
  (t) => [primaryKey({ columns: [t.passage_id, t.model] })],
);
export const wiki_pages = sqliteTable(
  "wiki_pages",
  {
    project_key: text("project_key").notNull(),
    project_id: text("project_id"),
    slug: text("slug").notNull(),
    revision: integer("revision").notNull(),
    payload: text("payload").notNull(),
  },
  (t) => [primaryKey({ columns: [t.project_key, t.slug] })],
);
export const wiki_revisions = sqliteTable(
  "wiki_revisions",
  {
    project_key: text("project_key").notNull(),
    slug: text("slug").notNull(),
    revision: integer("revision").notNull(),
    payload: text("payload").notNull(),
    contribution_id: text("contribution_id").notNull(),
    created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => [primaryKey({ columns: [t.project_key, t.slug, t.revision] })],
);
export const wiki_contributions = sqliteTable(
  "wiki_contributions",
  {
    id: text("id").primaryKey(),
    project_id: text("project_id"),
    source_id: text("source_id").notNull(),
    version: text("version").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    task_id: text("task_id"),
    summary: text("summary"),
    created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
    updated_at: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex("wiki_contribution_source_version").on(t.source_id, t.version),
    index("wiki_contribution_queue").on(t.status, t.created_at),
  ],
);
export const wiki_contribution_attempts = sqliteTable("wiki_contribution_attempts", {
  id: text("id").primaryKey(),
  contribution_id: text("contribution_id").notNull(),
  outcome: text("outcome").notNull(),
  summary: text("summary").notNull(),
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
});
export const skill_proposals = sqliteTable("skill_proposals", {
  id: text("id").primaryKey(),
  project_id: text("project_id"),
  skill_name: text("skill_name").notNull(),
  payload: text("payload").notNull(),
  status: text("status").notNull().default("proposed"),
  decision: text("decision"),
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
});
export const skill_evaluations = sqliteTable("skill_evaluations", {
  id: text("id").primaryKey(),
  proposal_id: text("proposal_id").notNull(),
  payload: text("payload").notNull(),
  result: text("result").notNull(),
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
});
export const skill_evaluation_jobs = sqliteTable("skill_evaluation_jobs", {
  proposal_id: text("proposal_id").primaryKey(),
  task_id: text("task_id"),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch())`),
});
export const skill_activations = sqliteTable(
  "skill_activations",
  {
    id: text("id").primaryKey(),
    project_key: text("project_key").notNull(),
    skill_name: text("skill_name").notNull(),
    proposal_id: text("proposal_id"),
    evaluation_id: text("evaluation_id"),
    raw: text("raw").notNull(),
    previous_raw: text("previous_raw").notNull(),
    base_hash: text("base_hash").notNull(),
    previous_hash: text("previous_hash").notNull(),
    active: integer("active").notNull().default(1),
    action: text("action").notNull(),
    reason: text("reason").notNull(),
    created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex("skill_activation_current")
      .on(t.project_key, t.skill_name)
      .where(sql`${t.active}=1`),
  ],
);
