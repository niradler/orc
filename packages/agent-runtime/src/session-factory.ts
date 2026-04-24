/**
 * Single place for backend selection + session start/resume logic.
 * Add a new provider here — task-loop, agent-runner, and chat all use this.
 */
import { createLogger } from "@orc/core/logger";
import { createBackend, hasBackend } from "./registry.js";
import type { AgentBackend, AgentBackendName, AgentSession, SessionOpts } from "./types.js";

const logger = createLogger("agent-runtime:session-factory");

/**
 * Resolve the right AgentBackend for a given name, with fallback chain:
 *   a2a         → A2A backend  (needs opts.a2aUrl)
 *   claude      → Claude SDK, then ACPX on failure
 *   <registered> → backend from registry (e.g. "agentapi")
 *   <unknown>   → ACPX with acpxAgent=name (e.g. name="codex")
 *
 * Returns the resolved backend and the opts to pass to it (may add acpxAgent).
 */
async function resolveBackend(
  name: string,
  opts: SessionOpts,
): Promise<{ backend: AgentBackend; resolvedOpts: SessionOpts }> {
  if (name === "a2a") {
    return { backend: createBackend("a2a"), resolvedOpts: opts };
  }

  if (name === "claude") {
    const claudeBackend = createBackend("claude");
    const preflight = await claudeBackend.preflight();
    if (preflight.ok) {
      return { backend: claudeBackend, resolvedOpts: opts };
    }
    logger.warn("Claude SDK preflight failed, falling back to ACPX", { error: preflight.error });
    // fall through to ACPX
  } else if (hasBackend(name)) {
    return { backend: createBackend(name as AgentBackendName), resolvedOpts: opts };
  }

  // Unknown name → treat as acpx agent identifier (e.g. "codex", "claude" fallback)
  return {
    backend: createBackend("acpx"),
    resolvedOpts: { ...opts, acpxAgent: opts.acpxAgent ?? name },
  };
}

/**
 * Open (or resume) an agent session.
 *
 * - If runtimeSessionId is provided, attempts resumeSession first, falls back to startSession.
 * - Does NOT call session.send() — caller owns the prompt.
 */
export async function openAgentSession(
  backendName: string,
  opts: SessionOpts,
  runtimeSessionId?: string,
): Promise<AgentSession> {
  const { backend, resolvedOpts } = await resolveBackend(backendName, opts);

  if (runtimeSessionId) {
    try {
      const session = await backend.resumeSession(runtimeSessionId, {
        ...resolvedOpts,
        runtimeSessionId,
      });
      logger.info(`Resumed session ${runtimeSessionId} via ${backendName}`);
      return session;
    } catch (err) {
      logger.warn(`Resume failed for ${backendName}, starting fresh`, { err });
    }
  }

  const session = await backend.startSession(resolvedOpts);
  logger.info(`Started new session via ${backendName}`);
  return session;
}

/**
 * Pick the first available backend from a priority list.
 * Used by callers that don't have a specific backend configured (e.g. chat fallback).
 */
export function pickAvailableBackend(priority: string[]): AgentBackend | null {
  const name = priority.find(hasBackend);
  return name ? createBackend(name as AgentBackendName) : null;
}
