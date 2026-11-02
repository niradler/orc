// Native sessions ORC is currently driving a turn in (chat sends and pushed human answers).
export const activeTurns = new Set<string>();

export function turnKey(host: string | null, backend: string, runtimeId: string): string {
  return `${host ?? "local"}:${backend}:${runtimeId}`;
}
