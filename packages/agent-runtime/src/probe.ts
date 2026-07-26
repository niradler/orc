import { createBackend, listRegisteredBackends } from "./registry.js";
import type { AgentBackendName, BackendKind } from "./types.js";

/**
 * What a caller needs to answer "can I actually run this agent, and if not,
 * what do I install?" - the question the UI and CLI could not answer before,
 * because availability was only ever discovered by trying to spawn something.
 */
export type BackendProbe = {
  name: string;
  kind: BackendKind;
  /** Usable right now: preflight passed. */
  available: boolean;
  /** Why it is not usable, verbatim from preflight. */
  error: string | null;
  /** What it needs, whether or not that is satisfied. */
  requires: string;
  /** Resolved binary or endpoint. */
  target: string | null;
  /** How the target was found: path, bundled, config, env. */
  source: string | null;
  version: string | null;
};

/** Kind for backends that do not describe themselves. */
const FALLBACK_KIND: Record<string, BackendKind> = {
  acpx: "cli",
  claude: "in-process",
  "claude-cli": "cli",
  "codex-cli": "cli",
  agentapi: "http",
  a2a: "http",
};

export async function probeBackend(name: AgentBackendName): Promise<BackendProbe> {
  let backend: ReturnType<typeof createBackend>;
  try {
    backend = createBackend(name);
  } catch (err) {
    return {
      name,
      kind: FALLBACK_KIND[name] ?? "cli",
      available: false,
      error: err instanceof Error ? err.message : String(err),
      requires: "a registered backend",
      target: null,
      source: null,
      version: null,
    };
  }

  const described = await Promise.resolve(backend.describe?.()).catch(() => undefined);

  // A backend that throws in preflight is unavailable, not fatal to the probe:
  // one broken backend must not hide the rest of the list.
  let available = false;
  let error: string | null = null;
  try {
    const result = await backend.preflight();
    available = result.ok;
    error = result.ok ? null : (result.error ?? "preflight failed");
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    name,
    kind: described?.kind ?? FALLBACK_KIND[name] ?? "cli",
    available,
    error,
    requires: described?.requires ?? "",
    target: described?.target ?? null,
    source: described?.source ?? null,
    version: described?.version ?? null,
  };
}

/** Probe every registered backend, concurrently. Never throws. */
export function probeBackends(): Promise<BackendProbe[]> {
  return Promise.all(listRegisteredBackends().map((name) => probeBackend(name)));
}
