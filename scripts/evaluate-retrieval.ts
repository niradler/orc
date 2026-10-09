import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassageIndex } from "@orc/db/retrieval";

const directory = join(process.cwd(), ".claude", "tooling", "wiki-evaluation", String(Date.now()));
mkdirSync(directory, { recursive: true });
const dbPath = join(directory, "evaluation.db");
const originals = new Map<string, string>();
let sqlite = new Database(dbPath);
let index = new PassageIndex(sqlite);
for (const path of [
  "README.md",
  "AGENTS.md",
  "docs/task-flows.md",
  "skills/orc-wiki/SKILL.md",
  "docs/evolving-wiki.md",
]) {
  const content = readFileSync(path, "utf8");
  originals.set(path, content);
  index.put({
    kind: "document",
    source_id: path,
    project_id: "orc",
    title: path,
    content,
    location: path,
    tags: [],
  });
}
for (let i = 0; i < 200; i++)
  index.put({
    kind: "memory",
    source_id: `noise-${i}`,
    project_id: "orc",
    title: "Routine event",
    content: `Routine completed operation ${i}.`,
    location: `test://noise/${i}`,
    tags: ["routine"],
  });
index.put({
  kind: "document",
  source_id: "expired",
  project_id: "orc",
  title: "join_deadlock",
  content: "join_deadlock reset_on_revisit no_matching_edge",
  location: "test://expired",
  valid_until: Math.floor(Date.now() / 1000) - 1,
});
index.put({
  kind: "document",
  source_id: "foreign",
  project_id: "other",
  title: "join_deadlock",
  content: "join_deadlock reset_on_revisit no_matching_edge",
  location: "test://foreign",
});
sqlite.close();
sqlite = new Database(dbPath);
index = new PassageIndex(sqlite);
const queries = [
  { query: "reset_on_revisit", source: "docs/task-flows.md", marker: "reset_on_revisit" },
  {
    query: "unsatisfiable join",
    source: "docs/task-flows.md",
    marker: "join_deadlock",
    alternatives: [{ source: "AGENTS.md", marker: "join_deadlock" }],
  },
  { query: "human gate resume", source: "docs/task-flows.md", marker: "orc flow resume" },
  { query: "ORC_API_SECRET Bearer", source: "README.md", marker: "ORC_API_SECRET" },
  { query: "whole process tree zombie socket", source: "AGENTS.md", marker: "grandchild" },
  {
    query: "root cause session evidence",
    source: "skills/orc-wiki/SKILL.md",
    marker: "root cause",
  },
  { query: "held-out candidate baseline", source: "docs/evolving-wiki.md", marker: "held-out" },
  { query: "optional embeddings degraded", source: "docs/evolving-wiki.md", marker: "degraded" },
];
const rows = [];
let correctCitations = 0;
let citationCount = 0;
let leaks = 0;
for (const gold of queries) {
  const started = performance.now();
  const result = await index.search({
    query: gold.query,
    project_id: "orc",
    limit: 5,
    token_budget: 2000,
  });
  const latency = performance.now() - started;
  const rank = result.passages.findIndex(
    (p) => p.source_id === gold.source && p.content.includes(gold.marker),
  );
  const acceptable = [{ source: gold.source, marker: gold.marker }, ...(gold.alternatives ?? [])];
  const answerRank = result.passages.findIndex((p) =>
    acceptable.some((label) => p.source_id === label.source && p.content.includes(label.marker)),
  );
  for (const passage of result.passages) {
    citationCount++;
    const original = originals.get(passage.source_id);
    if (original?.slice(passage.start, passage.end) === passage.content) correctCitations++;
    if (passage.project_id !== "orc" || ["expired", "foreign"].includes(passage.source_id)) leaks++;
  }
  rows.push({
    ...gold,
    rank: rank < 0 ? null : rank + 1,
    answer_rank: answerRank < 0 ? null : answerRank + 1,
    latency_ms: latency,
    estimated_tokens: result.estimated_tokens,
    semantic: result.capabilities.semantic,
  });
}
const report = {
  corpus: { documents: 5, noise: 200, stale: 1, foreign: 1 },
  queries: rows.length,
  recall_at_5: rows.filter((r) => r.rank !== null).length / rows.length,
  mrr_at_5: rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / rows.length,
  answer_recall_at_5: rows.filter((r) => r.answer_rank !== null).length / rows.length,
  answer_mrr_at_5:
    rows.reduce((sum, row) => sum + (row.answer_rank ? 1 / row.answer_rank : 0), 0) / rows.length,
  citation_accuracy: citationCount ? correctCitations / citationCount : 0,
  scope_or_validity_leaks: leaks,
  average_estimated_tokens: rows.reduce((sum, row) => sum + row.estimated_tokens, 0) / rows.length,
  average_latency_ms: rows.reduce((sum, row) => sum + row.latency_ms, 0) / rows.length,
  reopen: true,
  embeddings: false,
  limitations:
    "Small manually labeled ORC corpus, including feature documentation that mentions evaluation queries; not an independent held-out suite. Strict source ranks are retained separately from equivalent authoritative evidence. No semantic-model quality or skill-outcome claim.",
  rows,
};
writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ artifact: join(directory, "report.json"), ...report }, null, 2));
sqlite.close();
if (!citationCount || leaks || correctCitations !== citationCount) process.exitCode = 1;
