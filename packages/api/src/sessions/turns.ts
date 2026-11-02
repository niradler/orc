// Native sessions ORC is currently driving a turn in (chat sends and pushed human answers).
export const activeTurns = new Set<string>();
// Pushed human answers in flight; a chat send to the same session waits for them instead of failing.
export const deliveries = new Map<string, Promise<void>>();

export function turnKey(host: string | null, backend: string, runtimeId: string): string {
  return `${host ?? "local"}:${backend}:${runtimeId}`;
}
