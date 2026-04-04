import type { AgentBackend, AgentBackendName } from "./types.js";

const registry = new Map<AgentBackendName, () => AgentBackend>();

export function registerBackend(name: AgentBackendName, factory: () => AgentBackend): void {
  registry.set(name, factory);
}

export function createBackend(name: AgentBackendName): AgentBackend {
  const factory = registry.get(name);
  if (factory) return factory();
  const acpxFactory = registry.get("acpx");
  if (acpxFactory) return acpxFactory();
  throw new Error(`No agent backend registered for: ${name}`);
}

export function hasBackend(name: AgentBackendName): boolean {
  return registry.has(name);
}

export function listRegisteredBackends(): AgentBackendName[] {
  return [...registry.keys()];
}
