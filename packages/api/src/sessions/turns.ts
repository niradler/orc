export const activeTurns = new Set<string>();

export function turnKey(host: string | null, backend: string, runtimeId: string): string {
  return `${host ?? "local"}:${backend}:${runtimeId}`;
}

export type NativeSession = { host: string | null; backend: string; runtimeId: string };
// Null when no chat shows this session; the caller then pushes in the background.
export type ChatTurnRunner = (session: NativeSession, prompt: string) => Promise<void> | null;

let chatTurns: ChatTurnRunner = () => null;

export function registerChatTurns(runner: ChatTurnRunner): void {
  chatTurns = runner;
}

export function runChatTurn(session: NativeSession, prompt: string): Promise<void> | null {
  return chatTurns(session, prompt);
}
