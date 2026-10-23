import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type VectorBackend = "sqlite-vec" | "exact-scan";

const EXT = process.platform === "win32" ? "dll" : process.platform === "darwin" ? "dylib" : "so";

/**
 * Candidate vec0 locations, most explicit first:
 * ORC_SQLITE_VEC_PATH, <binary dir>/native (compiled CLI, desktop extraResources, Docker),
 * then the sqlite-vec npm platform package (source checkouts).
 */
async function candidates(): Promise<string[]> {
  const out: string[] = [];
  if (process.env.ORC_SQLITE_VEC_PATH) out.push(process.env.ORC_SQLITE_VEC_PATH);
  out.push(join(dirname(process.execPath), "native", `vec0.${EXT}`));
  try {
    const { getLoadablePath } = await import("sqlite-vec");
    out.push(getLoadablePath());
  } catch {
    // Unsupported platform (e.g. windows-arm64) or a compiled binary without node_modules.
  }
  return out;
}

/**
 * Loads sqlite-vec into the index connection. Embeddings are stored as plain float32 BLOBs, so the
 * extension only accelerates the distance computation; without it (Apple's system SQLite refuses
 * extensions, unsupported platforms) the same rows are scanned exactly in JS.
 */
export async function loadVectorBackend(
  db: Database,
): Promise<{ backend: VectorBackend; detail?: string }> {
  const errors: string[] = [];
  for (const path of await candidates()) {
    if (!existsSync(path)) continue;
    try {
      db.loadExtension(path);
      db.query("select vec_version()").get();
      return { backend: "sqlite-vec" };
    } catch (e) {
      errors.push(`${path}: ${(e as Error).message}`);
    }
  }
  return {
    backend: "exact-scan",
    detail: errors.length ? errors.join("; ") : "sqlite-vec extension not found",
  };
}

/** Reject invalid coordinates before float32 storage or distance calculation. */
export function validateVector(v: ArrayLike<number>, dimensions?: number): void {
  if (!v.length || (dimensions !== undefined && v.length !== dimensions))
    throw new Error("Embedding vector dimensions do not match");
  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    const coordinate = v[i];
    if (
      typeof coordinate !== "number" ||
      !Number.isFinite(coordinate) ||
      !Number.isFinite(Math.fround(coordinate))
    )
      throw new Error("Embedding vector contains an invalid coordinate");
    norm += Math.fround(coordinate) ** 2;
  }
  if (!norm) throw new Error("Embedding vector has zero magnitude");
}

export const encodeVector = (v: ArrayLike<number>) => {
  validateVector(v);
  const f = Float32Array.from(v);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
};

export const decodeVector = (blob: Uint8Array) =>
  new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));

export function cosineDistance(a: Float32Array, b: Float32Array): number {
  if (!a.length || a.length !== b.length)
    throw new Error("Embedding vector dimensions do not match");
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new Error("Embedding vector contains an invalid coordinate");
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) throw new Error("Embedding vector has zero magnitude");
  return Math.max(0, Math.min(2, 1 - dot / Math.sqrt(na * nb)));
}
