import type { AgentBackend, AgentBackendName } from "./types.js";

const registry = new Map<AgentBackendName, () => AgentBackend>();

export function registerBackend(name: AgentBackendName, factory: () => AgentBackend): void {
  registry.set(name, factory);
}

export function createBackend(name: AgentBackendName): AgentBackend {
  const factory = registry.get(name);
  if (!factory) throw new Error(`No agent backend registered for: ${name}`);
  return factory();
}

export function listRegisteredBackends(): AgentBackendName[] {
  return [...registry.keys()];
}
