import type { SessionDelivery } from "@orc/core/session-messages";

export const activeTurns = new Set<string>();

export function turnKey(host: string | null, backend: string, runtimeId: string): string {
  return `${host ?? "local"}:${backend}:${runtimeId}`;
}

export type NativeSession = { host: string | null; backend: string; runtimeId: string };
export type ChatTarget = NativeSession | { threadId: string };

export type ChatTurnOptions = {
  deliveries?: SessionDelivery[];
};

export type ChatControl = {
  turn(target: ChatTarget, prompt: string, options?: ChatTurnOptions): Promise<void> | null;
  steer(target: ChatTarget, text: string, options?: ChatTurnOptions): Promise<boolean>;
  canSteer(target: ChatTarget): boolean;
  stop(threadId: string): boolean;
  running(threadId: string): boolean;
  waiting(threadId: string): "question" | "approval" | null;
  full(): boolean;
  startPending(): void;
};

let control: ChatControl = {
  turn: () => null,
  steer: async () => false,
  canSteer: () => false,
  stop: () => false,
  running: () => false,
  waiting: () => null,
  full: () => true,
  startPending: () => {},
};

export function registerChatControl(next: ChatControl): void {
  control = next;
}

export function chatControl(): ChatControl {
  return control;
}

export function runChatTurn(
  session: ChatTarget,
  prompt: string,
  options?: ChatTurnOptions,
): Promise<void> | null {
  return control.turn(session, prompt, options);
}
