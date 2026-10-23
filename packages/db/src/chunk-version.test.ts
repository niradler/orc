import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { installKnowledgeBases } from "./kb.js";
import { installSessionArchive } from "./session-archive.js";

test("legacy revision schemas gain stable chunk-version metadata without changing stored rows", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE projects(id TEXT PRIMARY KEY);
      CREATE TABLE kb_document_revisions(document_id TEXT, revision INTEGER, content TEXT);
      CREATE TABLE session_archive_revisions(session_id TEXT, revision INTEGER, content_hash TEXT, file_hashes TEXT, blob TEXT, conflict INTEGER, created_at TEXT);
      INSERT INTO kb_document_revisions VALUES('doc',7,'original content');
      INSERT INTO session_archive_revisions VALUES('session',3,'hash','{}','retained.json',0,'2026-10-23');
    `);
    for (let reopen = 0; reopen < 3; reopen++) {
      installKnowledgeBases(db);
      installSessionArchive(db);
      expect(db.query("SELECT * FROM kb_document_revisions").get()).toEqual({
        document_id: "doc",
        revision: 7,
        content: "original content",
        chunk_version: 1,
      });
      expect(
        db.query("SELECT blob, revision, chunk_version FROM session_archive_revisions").get(),
      ).toEqual({ blob: "retained.json", revision: 3, chunk_version: 1 });
    }
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    db.close();
  }
});
