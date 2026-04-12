import type { GatewayAdapter, SupportsMessageUpdate } from "./types.js";

const MIN_INTERVAL_MS = 1500;
const MIN_DELTA = 30;
const MAX_LENGTH = 3000;

type PreviewState = {
  chatId: string;
  msgId: string;
  lastText: string;
  lastEditAt: number;
  frozen: boolean;
  degraded: boolean;
  pendingText: string | null;
  pendingTimer: ReturnType<typeof setTimeout> | null;
};

export class PreviewManager {
  private readonly states = new Map<string, PreviewState>();
  private readonly adapter: GatewayAdapter & SupportsMessageUpdate;

  constructor(adapter: GatewayAdapter & SupportsMessageUpdate) {
    this.adapter = adapter;
  }

  static supports(adapter: GatewayAdapter): adapter is GatewayAdapter & SupportsMessageUpdate {
    return (
      "updateMessage" in adapter &&
      typeof (adapter as GatewayAdapter & SupportsMessageUpdate).updateMessage === "function"
    );
  }

  async init(sessionId: string, chatId: string, msgId: string, initialText: string): Promise<void> {
    this.states.set(sessionId, {
      chatId,
      msgId,
      lastText: initialText,
      lastEditAt: 0,
      frozen: false,
      degraded: false,
      pendingText: null,
      pendingTimer: null,
    });
  }

  async update(sessionId: string, text: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state || state.degraded) return;

    const truncated = text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}\n…` : text;

    if (state.frozen) {
      state.pendingText = truncated;
      return;
    }

    const now = Date.now();
    const delta = Math.abs(truncated.length - state.lastText.length);
    const elapsed = now - state.lastEditAt;

    if (elapsed < MIN_INTERVAL_MS || delta < MIN_DELTA) {
      state.pendingText = truncated;
      if (!state.pendingTimer) {
        const delay = Math.max(MIN_INTERVAL_MS - elapsed, 100);
        state.pendingTimer = setTimeout(() => this.flushPending(sessionId), delay);
      }
      return;
    }

    await this.doEdit(state, truncated);
  }

  freeze(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (state) state.frozen = true;
  }

  unfreeze(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    state.frozen = false;
    if (state.pendingText) {
      void this.flushPending(sessionId);
    }
  }

  async finalize(sessionId: string, text: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) return;

    if (state.pendingTimer) {
      clearTimeout(state.pendingTimer);
      state.pendingTimer = null;
    }

    const truncated = text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}\n…` : text;
    if (!state.degraded && truncated !== state.lastText) {
      await this.doEdit(state, truncated);
    }
    this.states.delete(sessionId);
  }

  cleanup(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (state?.pendingTimer) clearTimeout(state.pendingTimer);
    this.states.delete(sessionId);
  }

  private async flushPending(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state?.pendingText || state.frozen) return;
    state.pendingTimer = null;
    const text = state.pendingText;
    state.pendingText = null;
    await this.doEdit(state, text);
  }

  private async doEdit(state: PreviewState, text: string): Promise<void> {
    try {
      await this.adapter.updateMessage(state.chatId, state.msgId, text);
      state.lastText = text;
      state.lastEditAt = Date.now();
    } catch {
      state.degraded = true;
    }
  }
}
