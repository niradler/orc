import { withHumanRequests } from "./human-requests.js";
import { providerSessionOptions, withProviderRedaction } from "./provider-session.js";
import { sessionRules } from "./rules.js";
import type { AgentBackend, AgentBackendName, SessionOpts } from "./types.js";

const registry = new Map<AgentBackendName, () => AgentBackend>();

function withSessionEnv(opts: SessionOpts): SessionOpts {
  const sessionId = opts.orcPreviewSessionId ?? opts.attentionContext?.chatThreadId;
  if (!sessionId || opts.env?.ORC_SESSION_ID) return opts;
  return { ...opts, env: { ...opts.env, ORC_SESSION_ID: sessionId } };
}

export function registerBackend(name: AgentBackendName, factory: () => AgentBackend): void {
  registry.set(name, factory);
}

/**
 * A backend that cannot enforce a whitelist normally refuses the session. When the caller marked
 * the allowlist optional (a KB digest: any backend is a valid choice), drop it and run with the
 * backend's own tools instead; the caller is responsible for warning about it.
 */
function resolveToolAllowlist(name: string, opts: SessionOpts, supported: boolean): SessionOpts {
  if (opts.toolAllowlist === undefined || supported) return opts;
  if (!opts.toolAllowlistOptional)
    throw new Error(
      `Backend ${name} cannot enforce this session's tool whitelist; refusing to run unrestricted`,
    );
  return { ...opts, toolAllowlist: undefined };
}

/**
 * Create a registered backend.
 *
 * Throws on an unknown name rather than substituting acpx. Routing an unknown
 * name to an agent *is* intended behaviour, but it belongs one level up, in
 * `resolveBackend()` (session-factory), which passes the name through as acpx's
 * agent identifier - `--agent-backend gemini` means "acpx driving gemini".
 * Doing it here instead silently ran acpx's *default* agent, so a typo'd
 * backend looked like it worked, and a missing acpx surfaced as a spawn failure
 * from a backend nobody had chosen.
 */
export function createBackend(name: AgentBackendName): AgentBackend {
  const factory = registry.get(name);
  if (factory) {
    const backend = factory();
    const forkSession = backend.forkSession;
    return {
      ...backend,
      preflight: async (opts = {}) => {
        const resolved = providerSessionOptions(String(name), opts, true);
        let result: Awaited<ReturnType<AgentBackend["preflight"]>>;
        try {
          result = await backend.preflight(resolved);
        } catch (error) {
          throw new Error(
            resolved.redactOutput?.(error instanceof Error ? error.message : String(error)) ??
              String(error),
          );
        }
        return result.error && resolved.redactOutput
          ? { ...result, error: resolved.redactOutput(result.error) }
          : result;
      },
      startSession: async (opts) => {
        opts = withSessionEnv(providerSessionOptions(String(name), opts));
        opts = resolveToolAllowlist(
          String(name),
          opts,
          backend.profileCapabilities?.toolAllowlist === true,
        );
        return withHumanRequests(
          withProviderRedaction(
            await backend
              .startSession(await sessionRules(String(name), opts))
              .catch((error: unknown) => {
                throw new Error(
                  opts.redactOutput?.(error instanceof Error ? error.message : String(error)) ??
                    String(error),
                );
              }),
            opts,
          ),
          String(name),
          opts,
        );
      },
      resumeSession: async (id, opts) => {
        opts = withSessionEnv(providerSessionOptions(String(name), opts, true));
        opts = resolveToolAllowlist(
          String(name),
          opts,
          backend.profileCapabilities?.toolAllowlist === true,
        );
        return withHumanRequests(
          withProviderRedaction(
            await backend
              .resumeSession(id, await sessionRules(String(name), opts))
              .catch((error: unknown) => {
                throw new Error(
                  opts.redactOutput?.(error instanceof Error ? error.message : String(error)) ??
                    String(error),
                );
              }),
            opts,
          ),
          String(name),
          opts,
        );
      },
      ...(forkSession
        ? {
            forkSession: async (sourceRuntimeId: string, opts: SessionOpts) => {
              opts = withSessionEnv(providerSessionOptions(String(name), opts, true));
              opts = resolveToolAllowlist(
                String(name),
                opts,
                backend.profileCapabilities?.toolAllowlist === true,
              );
              return withHumanRequests(
                withProviderRedaction(
                  await forkSession
                    .call(backend, sourceRuntimeId, await sessionRules(String(name), opts))
                    .catch((error: unknown) => {
                      throw new Error(
                        opts.redactOutput?.(
                          error instanceof Error ? error.message : String(error),
                        ) ?? String(error),
                      );
                    }),
                  opts,
                ),
                String(name),
                opts,
              );
            },
          }
        : {}),
    };
  }
  throw new Error(
    `No agent backend registered for "${name}". Registered: ${listRegisteredBackends().join(", ")}. ` +
      "To reach an agent through acpx, pass it as the agent name instead of the backend.",
  );
}

export function hasBackend(name: AgentBackendName): boolean {
  return registry.has(name);
}

export function listRegisteredBackends(): AgentBackendName[] {
  return [...registry.keys()];
}

/**
 * Whether a registered backend can restrict a session to an explicit tool whitelist.
 *
 * Callers that must restrict tools (a KB digest, an agent package profile) use this to
 * reject an incapable backend up front instead of scheduling work that can never run.
 */
export function backendSupportsToolAllowlist(name: string): boolean {
  const factory = registry.get(name as AgentBackendName);
  if (!factory) return false;
  try {
    return factory().profileCapabilities?.toolAllowlist === true;
  } catch {
    return false;
  }
}

export function toolAllowlistBackends(): string[] {
  return listRegisteredBackends().filter((name) => backendSupportsToolAllowlist(name));
}
