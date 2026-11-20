import type { ToolResult } from "./meta-tools.js";

/**
 * Unified discovery across ORC's native tools and external Spec connections.
 *
 * External tools live behind registered Spec connections (OpenAPI / MCP / GraphQL) and are
 * invisible to a native-only search. Without this, an agent that needs an external tool has no
 * signpost that external catalogs exist and must guess the literal "spec" path. Fan-out queries
 * every enabled connection (bounded, best-effort) and merges tagged hits so external functionality
 * surfaces on the first search; the connection list is always returned as a signpost.
 */

export interface SpecConnection {
  name: string;
  description: string;
}

export interface ExternalToolHit {
  name: string;
  description: string;
  connection: string;
  external: true;
}

export interface SpecDiscovery {
  connections: SpecConnection[];
  hitsByQuery: Map<string, ExternalToolHit[]>;
  partial: boolean;
}

const PER_CONNECTION = 5;
const MAX_HITS_PER_QUERY = 15;
const TIMEOUT_MS = 4000;

function parseJsonArray(result: ToolResult): Record<string, unknown>[] {
  if (result.isError) return [];
  try {
    const value = JSON.parse(result.content[0]?.text ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Spec search timed out")), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Bounded like the fan-out: a slow or failing registry must not hold up a search. Throws on failure. */
export async function listSpecConnections(
  callTool: (name: string, args: unknown) => Promise<ToolResult>,
): Promise<SpecConnection[]> {
  const result = await withTimeout(callTool("spec_list", {}), TIMEOUT_MS);
  if (result.isError) throw new Error("Spec connection listing failed");
  return parseJsonArray(result)
    .filter((entry) => typeof entry.name === "string")
    .map((entry) => ({
      name: entry.name as string,
      description: typeof entry.description === "string" ? entry.description : "",
    }));
}

/**
 * Fan out one or more queries across enabled Spec connections. Pass an empty query list to fetch
 * only the connection signpost (no per-connection search). Best-effort: a slow or failing
 * connection is skipped and flagged via `partial`, never blocking the native results.
 */
export async function discoverSpecTools(
  callTool: (name: string, args: unknown) => Promise<ToolResult>,
  queries: string[],
): Promise<SpecDiscovery> {
  const hitsByQuery = new Map<string, ExternalToolHit[]>();
  let connections: SpecConnection[];
  try {
    connections = await listSpecConnections(callTool);
  } catch {
    // Without the connection list no external catalog can be searched; flag the gap.
    return { connections: [], hitsByQuery, partial: true };
  }
  if (connections.length === 0 || queries.length === 0)
    return { connections, hitsByQuery, partial: false };

  const pairs = queries.flatMap((query) =>
    connections.map((connection) => ({ query, connection })),
  );
  const settled = await Promise.allSettled(
    pairs.map(async ({ query, connection }) => {
      const result = await withTimeout(
        callTool("spec_tools", { connection: connection.name, query, limit: PER_CONNECTION }),
        TIMEOUT_MS,
      );
      return {
        query,
        connection: connection.name,
        hits: parseJsonArray(result),
        failed: result.isError === true,
      };
    }),
  );

  let partial = false;
  for (const entry of settled) {
    if (entry.status !== "fulfilled") {
      partial = true;
      continue;
    }
    const { query, connection, hits, failed } = entry.value;
    if (failed) partial = true;
    const collected = hitsByQuery.get(query) ?? [];
    for (const hit of hits) {
      if (collected.length >= MAX_HITS_PER_QUERY) break;
      if (typeof hit.id !== "string") continue;
      collected.push({
        name: hit.id,
        description: typeof hit.description === "string" ? hit.description : "",
        connection,
        external: true,
      });
    }
    hitsByQuery.set(query, collected);
  }
  return { connections, hitsByQuery, partial };
}

export function specSignpost(connections: SpecConnection[]): string {
  if (connections.length === 0) return "";
  const list = connections
    .map((connection) =>
      connection.description ? `${connection.name} (${connection.description})` : connection.name,
    )
    .join(", ");
  return `\n\nExternal tool connections: ${list}. These are external tools, not ORC built-ins; pass connection=<name> to search, describe, or call them.`;
}

export function externalHitLine(hit: ExternalToolHit, firstLine: (text: string) => string): string {
  return `${hit.name}: ${firstLine(hit.description)} [external: ${hit.connection}]`;
}

/** Label a single external tool result (e.g. spec_describe) so it is never mistaken for a built-in. */
export function markExternal(result: ToolResult, connection: string): ToolResult {
  if (result.isError) return result;
  try {
    const value = JSON.parse(result.content[0]?.text ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const marked = { ...value, external: true, connection };
      return {
        content: [{ type: "text", text: JSON.stringify(marked, null, 2) }],
        structuredContent: marked,
      };
    }
  } catch {
    // non-JSON payload: leave unchanged
  }
  return result;
}
