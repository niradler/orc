import { zstdDecompressSync } from "node:zlib";
import type { HostRuntime } from "@orc/core/exec-host";
import { opencodeTranscriptBytes } from "./opencode.js";
import { MAX_TRANSCRIPT_BYTES } from "./transcript.js";

type TranscriptSource = (
  runtime: HostRuntime,
  path: string,
  externalId: string | null,
) => Promise<Uint8Array>;

const databaseSources: Record<string, TranscriptSource> = {
  opencode: (runtime, path, externalId) => {
    if (!externalId) throw new Error("OpenCode session has no session id");
    return opencodeTranscriptBytes(runtime, path, externalId);
  },
};

export async function readTranscriptFile(
  runtime: Pick<HostRuntime, "readFile">,
  path: string,
  limit = MAX_TRANSCRIPT_BYTES,
): Promise<Uint8Array> {
  const bytes = await runtime.readFile(path, limit);
  return path.endsWith(".zst") ? zstdDecompressSync(bytes, { maxOutputLength: limit }) : bytes;
}

/** Reads a session transcript as bytes, querying stores that keep many sessions in one database. */
export function loadTranscriptBytes(
  runtime: HostRuntime,
  backend: string,
  path: string,
  externalId: string | null,
): Promise<Uint8Array> {
  const source = databaseSources[backend];
  return source ? source(runtime, path, externalId) : readTranscriptFile(runtime, path);
}

export function transcriptCacheKey(
  host: string,
  backend: string,
  path: string,
  externalId: string | null,
) {
  return databaseSources[backend] ? `${host}:${path}#${externalId ?? ""}` : `${host}:${path}`;
}
