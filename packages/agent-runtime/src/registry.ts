import { withHumanRequests } from "./human-requests.js";
import { providerSessionOptions, withProviderRedaction } from "./provider-session.js";
import { sessionRules } from "./rules.js";
import type { AgentBackend, AgentBackendName } from "./types.js";

const registry = new Map<AgentBackendName, () => AgentBackend>();

export function registerBackend(name: AgentBackendName, factory: () => AgentBackend): void {
  registry.set(name, factory);
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
    return {
      ...backend,
      preflight: async (opts = {}) => {
        const resolved = providerSessionOptions(String(name), opts, true);
        let result: Awaited<ReturnType<AgentBackend["preflight"]>>;
        try {
          result = await backend.preflight(resolved);
        } catch (error) {
          throw new Error(
            resolved.providerRedact?.(error instanceof Error ? error.message : String(error)) ??
              String(error),
          );
        }
        return result.error && resolved.providerRedact
          ? { ...result, error: resolved.providerRedact(result.error) }
          : result;
      },
      startSession: async (opts) => {
        opts = providerSessionOptions(String(name), opts);
        if (opts.toolAllowlist !== undefined && !backend.profileCapabilities?.toolAllowlist)
          throw new Error(
            `Backend ${name} cannot enforce this session's tool whitelist; refusing to run unrestricted`,
          );
        return withHumanRequests(
          withProviderRedaction(
            await backend
              .startSession(await sessionRules(String(name), opts))
              .catch((error: unknown) => {
                throw new Error(
                  opts.providerRedact?.(error instanceof Error ? error.message : String(error)) ??
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
        opts = providerSessionOptions(String(name), opts, true);
        if (opts.toolAllowlist !== undefined && !backend.profileCapabilities?.toolAllowlist)
          throw new Error(
            `Backend ${name} cannot enforce this session's tool whitelist; refusing to run unrestricted`,
          );
        return withHumanRequests(
          withProviderRedaction(
            await backend
              .resumeSession(id, await sessionRules(String(name), opts))
              .catch((error: unknown) => {
                throw new Error(
                  opts.providerRedact?.(error instanceof Error ? error.message : String(error)) ??
                    String(error),
                );
              }),
            opts,
          ),
          String(name),
          opts,
        );
      },
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
