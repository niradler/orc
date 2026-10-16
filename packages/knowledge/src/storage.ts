import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type ParsedDocument, ParsedDocumentSchema } from "@orc/core/kb";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const EXT = /^[a-z0-9]{1,10}$/;

/**
 * Managed knowledge storage under one root:
 *   originals/<kb>/<doc>/r<rev>-<sha12>.<ext>   immutable uploaded bytes
 *   artifacts/<doc>/h<sha16>/<parser>@<version>.json  ParsedDocument per content + parser version
 *   index.db                                      rebuildable search index
 *   runtime/                                      optional parser runtimes (not user data)
 *   tmp/                                          staging; safe to clear when idle
 * Every path is built from validated IDs and checked to stay inside the root.
 */
export class KnowledgeStorage {
  readonly root: string;

  constructor(root: string) {
    if (!root || !isAbsolute(root)) throw new Error("Knowledge root must be an absolute path");
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  get indexPath() {
    return join(this.root, "index.db");
  }

  private inside(...parts: string[]): string {
    for (const p of parts)
      if (p === "." || p === ".." || !/^[A-Za-z0-9_.@-]{1,128}$/.test(p))
        throw new Error(`Invalid storage path segment: ${p}`);
    const full = resolve(this.root, ...parts);
    const rel = relative(this.root, full);
    if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))
      throw new Error("Storage path escapes the knowledge root");
    return full;
  }

  /** Atomic write: temp file in tmp/ then rename, so readers never see partial files. */
  private writeAtomic(path: string, data: Uint8Array | string) {
    mkdirSync(dirname(path), { recursive: true });
    const tmpDir = join(this.root, "tmp");
    mkdirSync(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.part`);
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  }

  static sha256(data: Uint8Array | string) {
    return createHash("sha256").update(data).digest("hex");
  }

  /** Stores an original and returns its root-relative path (recorded in the revision). */
  putOriginal(
    kbId: string,
    docId: string,
    revision: number,
    ext: string,
    bytes: Uint8Array,
  ): string {
    if (!ID.test(kbId) || !ID.test(docId)) throw new Error("Invalid ID");
    const safeExt = EXT.test(ext) ? ext : "bin";
    const sha = KnowledgeStorage.sha256(bytes);
    const name = `r${revision}-${sha.slice(0, 12)}.${safeExt}`;
    const full = this.inside("originals", kbId, docId, name);
    if (!existsSync(full)) this.writeAtomic(full, bytes);
    return relative(this.root, full).split(sep).join("/");
  }

  resolveRel(rel: string): string {
    const parts = rel.split("/");
    return this.inside(...parts);
  }

  readOriginal(rel: string): Buffer {
    return readFileSync(this.resolveRel(rel));
  }

  artifactPath(docId: string, contentHash: string, parserId: string, version: string) {
    return this.inside(
      "artifacts",
      docId,
      `h${contentHash.slice(0, 16)}`,
      `${parserId}@${version.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`,
    );
  }

  putArtifact(docId: string, doc: ParsedDocument) {
    const path = this.artifactPath(docId, doc.source_sha256, doc.parser.id, doc.parser.version);
    this.writeAtomic(path, JSON.stringify(doc));
    return path;
  }

  readArtifact(
    docId: string,
    contentHash: string,
    parserId: string,
    version: string,
  ): ParsedDocument | null {
    const path = this.artifactPath(docId, contentHash, parserId, version);
    if (!existsSync(path)) return null;
    const parsed = ParsedDocumentSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  }

  /**
   * Generated Markdown projection of an authored document (documents/<kb>/<doc>.md). The orc.db
   * revision is authoritative; this file is a readable, portable copy refreshed after each write.
   */
  projectionPath(kbId: string, docId: string) {
    if (!ID.test(kbId) || !ID.test(docId)) throw new Error("Invalid ID");
    return this.inside("documents", kbId, `${docId}.md`);
  }

  putProjection(kbId: string, docId: string, markdown: string) {
    this.writeAtomic(this.projectionPath(kbId, docId), markdown);
  }

  hasProjection(kbId: string, docId: string) {
    return existsSync(this.projectionPath(kbId, docId));
  }

  removeDocument(kbId: string, docId: string) {
    rmSync(this.inside("originals", kbId, docId), { recursive: true, force: true });
    rmSync(this.inside("artifacts", docId), { recursive: true, force: true });
    rmSync(this.projectionPath(kbId, docId), { force: true });
  }

  /** Artifacts are keyed by document, so the caller passes the KB's document IDs. */
  removeKb(kbId: string, docIds: string[]) {
    for (const id of docIds) rmSync(this.inside("artifacts", id), { recursive: true, force: true });
    rmSync(this.inside("originals", kbId), { recursive: true, force: true });
    rmSync(this.inside("documents", kbId), { recursive: true, force: true });
  }

  /** Writes upload bytes for a parser job; parsers read a stable file path. */
  workDir() {
    const dir = join(this.root, "tmp", "jobs");
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}
