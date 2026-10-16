import type { Database } from "bun:sqlite";
import { extractLinks, linkKey } from "./markdown.js";

/** Keys a document answers to: its title, its path and its file name (all without extension). */
export function documentKeys(doc: { title: string; path: string }): string[] {
  const path = doc.path.replace(/\.[^./]+$/, "");
  return [
    ...new Set([linkKey(doc.title), linkKey(path), linkKey(path.split("/").pop() ?? "")]),
  ].filter(Boolean);
}

export function setDocumentLinks(
  db: Database,
  doc: { id: string; kb_id: string },
  markdown: string | null,
) {
  const targets = markdown ? extractLinks(markdown) : [];
  const insert = db.query(
    "INSERT OR IGNORE INTO kb_links (from_id, kb_id, target, to_id) VALUES (?, ?, ?, NULL)",
  );
  db.transaction(() => {
    db.run("DELETE FROM kb_links WHERE from_id = ?", [doc.id]);
    for (const t of targets) insert.run(doc.id, doc.kb_id, t);
  })();
  resolveKbLinks(db, doc.kb_id);
}

/** Re-resolves every link in a KB. Links are KB-local; ambiguous keys resolve to the oldest doc. */
export function resolveKbLinks(db: Database, kbId: string) {
  const docs = db
    .query("SELECT id, title, path FROM kb_documents WHERE kb_id = ? ORDER BY created_at, id")
    .all(kbId) as { id: string; title: string; path: string }[];
  const byKey = new Map<string, string>();
  for (const d of docs) for (const k of documentKeys(d)) if (!byKey.has(k)) byKey.set(k, d.id);
  const links = db
    .query("SELECT from_id, target, to_id FROM kb_links WHERE kb_id = ?")
    .all(kbId) as {
    from_id: string;
    target: string;
    to_id: string | null;
  }[];
  const update = db.query("UPDATE kb_links SET to_id = ? WHERE from_id = ? AND target = ?");
  db.transaction(() => {
    for (const l of links) {
      const to = byKey.get(l.target) ?? null;
      if (to !== l.to_id) update.run(to, l.from_id, l.target);
    }
  })();
}
