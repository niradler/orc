/**
 * Single place for backend selection + session start/resume logic.
 * Add a new provider here — task-loop, agent-runner, and chat all use this.
 */

import type { AgentFull } from "@orc/core/agent-service";
import { readAgent, renderAgentInstructions } from "@orc/core/agent-service";
import { createLogger } from "@orc/core/logger";
import { packageInstructionsForAgent } from "@orc/core/package-service";
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
  let profile: AgentFull | null = null;
  if (opts.agentProfile) {
    profile = readAgent(opts.agentProfile, opts.cwd);
    if (!profile) throw new Error(`Agent profile not found: ${opts.agentProfile}`);
  }
  const profileOpts = applyAgentProfile(opts, profile);
  const { backend, resolvedOpts } = await resolveBackend(backendName, profileOpts);
  validateProfileCapabilities(backend, resolvedOpts, profile);
  const context = profile
    ? [renderAgentInstructions(profile), packageInstructionsForAgent(profile.path)]
        .filter(Boolean)
        .join("\n\n")
    : "";
  const wrap = (session: AgentSession): AgentSession => {
    if (!profile) return session;
    return {
      id: session.id,
      send: (prompt, images) => session.send(`${context}\n\n${prompt}`, images),
      respondPermission: (requestId, result) => session.respondPermission(requestId, result),
      events: () => session.events(),
      alive: () => session.alive(),
      close: () => session.close(),
    };
  };

  if (runtimeSessionId) {
    try {
      const session = await backend.resumeSession(runtimeSessionId, {
        ...resolvedOpts,
        runtimeSessionId,
      });
      logger.info(`Resumed session ${runtimeSessionId} via ${backendName}`);
      return wrap(session);
    } catch (err) {
      logger.warn(`Resume failed for ${backendName}, starting fresh`, { err });
    }
  }

  const session = await backend.startSession(resolvedOpts);
  logger.info(`Started new session via ${backendName}`);
  return wrap(session);
}

export function applyAgentProfile(opts: SessionOpts, profile: AgentFull | null): SessionOpts {
  if (!profile) return opts;
  let toolAllowlist: string[] | undefined;
  const tools = profile.fields.tools;
  if (typeof tools === "string") toolAllowlist = tools.split(/[\s,]+/).filter(Boolean);
  else if (Array.isArray(tools)) toolAllowlist = tools;
  else if (tools !== undefined)
    toolAllowlist = Object.entries(tools)
      .filter(([, allowed]) => allowed)
      .map(([name]) => name);
  return {
    ...opts,
    model: opts.model ?? profile.fields.model,
    ...(toolAllowlist !== undefined ? { toolAllowlist } : {}),
  };
}

export function validateProfileCapabilities(
  backend: AgentBackend,
  opts: SessionOpts,
  profile: AgentFull | null,
): void {
  if (!profile) return;
  if (profile.fields.model && !backend.profileCapabilities?.model)
    throw new Error(`Backend ${backend.name} cannot honor profile model ${profile.fields.model}`);
  if (opts.toolAllowlist !== undefined && !backend.profileCapabilities?.toolAllowlist)
    throw new Error(
      `Backend ${backend.name} cannot enforce the tool whitelist for agent ${profile.id}; the profile will not run unrestricted`,
    );
}

/**
 * Pick the first backend from a priority list that is registered **and** passes
 * preflight. The previous version only checked registration and still called
 * itself "available", so it happily returned a backend whose service was down
 * or whose CLI was missing - the caller then failed at session start instead of
 * moving on to the next candidate.
 */
export async function pickUsableBackend(priority: string[]): Promise<AgentBackend | null> {
  for (const name of priority) {
    if (!hasBackend(name)) continue;
    const backend = createBackend(name as AgentBackendName);
    try {
      const preflight = await backend.preflight();
      if (preflight.ok) return backend;
      logger.debug(`Backend ${name} is registered but not usable`, { error: preflight.error });
    } catch (err) {
      logger.debug(`Backend ${name} preflight threw`, { err });
    }
  }
  return null;
}
