import type { GatewayAdapter } from "./types.js";

type AdapterFactory = (startTime: number) => GatewayAdapter;

const registry = new Map<string, AdapterFactory>();

export function registerAdapter(name: string, factory: AdapterFactory): void {
  registry.set(name, factory);
}

export function createAdapter(name: string, startTime: number): GatewayAdapter {
  const factory = registry.get(name);
  if (!factory) throw new Error(`No adapter registered for: ${name}`);
  return factory(startTime);
}

export function listRegisteredAdapters(): string[] {
  return [...registry.keys()];
}
