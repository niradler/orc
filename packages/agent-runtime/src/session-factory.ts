/**
 * Single place for backend selection + session start/resume logic.
 * Add a new provider here — task-loop, agent-runner, and chat all use this.
 */

import type { AgentFull } from "@orc/core/agent-service";
import { readAgent, renderAgentInstructions } from "@orc/core/agent-service";
import { AGENT_COMMAND_PATTERN } from "@orc/core/chat";
import { loadConfig } from "@orc/core/config";
import { createLogger } from "@orc/core/logger";
import { packageInstructionsForAgent } from "@orc/core/package-service";
import { sessionExecHost } from "./execution-host.js";
import { backendSupportsToolAllowlist, createBackend, hasBackend } from "./registry.js";
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
  if (loadConfig().agent_loop.acp_commands?.[name])
    return { backend: createBackend("acp"), resolvedOpts: { ...opts, acpAgent: name } };
  if (name === "a2a") {
    return { backend: createBackend("a2a"), resolvedOpts: opts };
  }

  if (name === "claude") {
    const claudeBackend = createBackend("claude");
    const preflight = await claudeBackend.preflight(opts);
    if (preflight.ok) {
      return { backend: claudeBackend, resolvedOpts: opts };
    }
    if (sessionExecHost(opts).kind === "ssh") {
      throw new Error(preflight.error ?? "Claude SDK preflight failed");
    }
    logger.warn("Claude SDK preflight failed, falling back to ACPX", {
      error: preflight.error,
    });
    // fall through to ACPX
  } else if (hasBackend(name)) {
    return {
      backend: createBackend(name as AgentBackendName),
      resolvedOpts: opts,
    };
  }

  // Unknown name → treat as acpx agent identifier (e.g. "codex", "claude" fallback)
  return {
    backend: createBackend("acpx"),
    resolvedOpts: { ...opts, acpxAgent: opts.acpxAgent ?? name },
  };
}

/**
 * Whether the backend a name will **actually run on** can enforce a tool whitelist, and the
 * name of that backend.
 *
 * `resolveBackend` reroutes: "claude" falls back to acpx when its preflight fails, and an
 * unknown name runs as acpx's agent. Callers have to judge the resolved backend, because the
 * requested name hides the fallback it is about to hit — a KB digest asking for "claude" on a
 * machine without a working Claude install ends up on acpx and runs without the whitelist.
 *
 * The preflight this triggers is the same one `openAgentSession` runs a moment later.
 */
export async function resolveToolAllowlistSupport(
  name: string,
  opts: SessionOpts,
): Promise<{ allowed: boolean; resolved: string }> {
  let backend: AgentBackend;
  try {
    backend = (await resolveBackend(name, opts)).backend;
  } catch (err) {
    // Resolution never got to a backend (e.g. an ssh host refusing the fallback), so judge the
    // requested name and let openAgentSession surface the real failure.
    logger.debug(`Backend ${name} could not be resolved for a tool-whitelist check`, { err });
    return { allowed: backendSupportsToolAllowlist(name), resolved: name };
  }
  return {
    allowed: backend.profileCapabilities?.toolAllowlist === true,
    resolved: backend.name,
  };
}

/**
 * Open (or resume) an agent session.
 *
 * - If runtimeSessionId is provided, resumes it or fails without replacing the identity.
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
  // Profile instructions are system instructions: they ride the same delivery as
  // systemPromptAppend (a system slot re-applied each turn, or the first prompt of
  // a prompt-riding session) instead of being re-concatenated into every user
  // prompt and steer, which repeated them for the life of the conversation.
  const sessionOpts: SessionOpts = context
    ? {
        ...resolvedOpts,
        systemPromptAppend: [resolvedOpts.systemPromptAppend, context].filter(Boolean).join("\n\n"),
      }
    : resolvedOpts;
  // Sessions that consume the append themselves need no prompt wrapping. A session
  // that ignores it (no system slot, no first-prompt delivery) still receives the
  // profile in the prompt, but only until a turn confirms delivery — never on steer.
  const wrap = (session: AgentSession): AgentSession => {
    if (!context || session.systemPromptOnce || session.systemPromptSlot) return session;
    let pending = !sessionOpts.systemPromptDelivered;
    return {
      id: session.id,
      systemPromptOnce: session.systemPromptOnce,
      systemPromptSlot: session.systemPromptSlot,
      get capabilities() {
        return session.capabilities;
      },
      ...(session.interrupt ? { interrupt: session.interrupt.bind(session) } : {}),
      ...(session.steer ? { steer: session.steer.bind(session) } : {}),
      ...(session.setPermissionMode
        ? { setPermissionMode: session.setPermissionMode.bind(session) }
        : {}),
      getRuntimeSessionId: () => session.getRuntimeSessionId?.(),
      send: (prompt, images) => {
        const prepend = pending && !AGENT_COMMAND_PATTERN.test(prompt.trim());
        if (prepend) pending = false;
        return session.send(prepend ? `${context}\n\n${prompt}` : prompt, images);
      },
      respondPermission: (requestId, result, feedback) =>
        session.respondPermission(requestId, result, feedback),
      ...(session.respondQuestion
        ? {
            respondQuestion: (id: string, answers: Record<string, string[]>) =>
              session.respondQuestion?.(id, answers),
          }
        : {}),
      waitingForHuman: () => session.waitingForHuman?.() === true,
      reusable: session.reusable,
      ...(session.canStopRuntime
        ? { canStopRuntime: () => session.canStopRuntime?.() ?? true }
        : {}),
      ...(session.setModel
        ? { setModel: (model: string) => session.setModel?.(model) ?? Promise.resolve() }
        : {}),
      ...(session.onUnexpectedExit
        ? { onUnexpectedExit: (listener) => session.onUnexpectedExit?.(listener) ?? (() => {}) }
        : {}),
      events: () => session.events(),
      alive: () => session.alive(),
      close: () => session.close(),
    };
  };

  if (runtimeSessionId) {
    try {
      const session = await backend.resumeSession(runtimeSessionId, {
        ...sessionOpts,
        runtimeSessionId,
      });
      logger.info(`Resumed session ${runtimeSessionId} via ${backendName}`);
      return wrap(session);
    } catch (err) {
      throw new Error(
        `Could not resume ${backendName} session; the original identity was preserved.`,
        { cause: err },
      );
    }
  }

  const session = await backend.startSession(sessionOpts);
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
  const allowed =
    toolAllowlist !== undefined && opts.toolAllowlist !== undefined
      ? toolAllowlist.filter((tool) => opts.toolAllowlist?.includes(tool))
      : (toolAllowlist ?? opts.toolAllowlist);
  return {
    ...opts,
    model: opts.model ?? profile.fields.model,
    ...(allowed !== undefined ? { toolAllowlist: allowed } : {}),
  };
}

export function validateProfileCapabilities(
  backend: AgentBackend,
  opts: SessionOpts,
  profile: AgentFull | null,
): void {
  if (profile?.fields.model && !backend.profileCapabilities?.model)
    throw new Error(`Backend ${backend.name} cannot honor profile model ${profile.fields.model}`);
  if (
    opts.toolAllowlist !== undefined &&
    !backend.profileCapabilities?.toolAllowlist &&
    !opts.toolAllowlistOptional
  )
    throw new Error(
      `Backend ${backend.name} cannot enforce this session's tool whitelist; refusing to run unrestricted`,
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
      logger.debug(`Backend ${name} is registered but not usable`, {
        error: preflight.error,
      });
    } catch (err) {
      logger.debug(`Backend ${name} preflight threw`, { err });
    }
  }
  return null;
}
