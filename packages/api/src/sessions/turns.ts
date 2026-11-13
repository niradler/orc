export const activeTurns = new Set<string>();

export function turnKey(host: string | null, backend: string, runtimeId: string): string {
  return `${host ?? "local"}:${backend}:${runtimeId}`;
}

export type NativeSession = { host: string | null; backend: string; runtimeId: string };
export type ChatTarget = NativeSession | { threadId: string };

export type ChatControl = {
  turn(target: ChatTarget, prompt: string): Promise<void> | null;
  steer(target: ChatTarget, text: string): Promise<boolean>;
  canSteer(target: ChatTarget): boolean;
  stop(threadId: string): boolean;
  running(threadId: string): boolean;
  full(): boolean;
};

let control: ChatControl = {
  turn: () => null,
  steer: async () => false,
  canSteer: () => false,
  stop: () => false,
  running: () => false,
  full: () => true,
};

export function registerChatControl(next: ChatControl): void {
  control = next;
}

export function chatControl(): ChatControl {
  return control;
}

export function runChatTurn(session: ChatTarget, prompt: string): Promise<void> | null {
  return control.turn(session, prompt);
}
