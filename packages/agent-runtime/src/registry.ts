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
  if (factory) return factory();
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
