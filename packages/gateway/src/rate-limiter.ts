const WINDOW_MS = 60_000;
const MAX_MESSAGES = 20;

export class RateLimiter {
  private readonly windows = new Map<string, number[]>();

  allow(chatKey: string): boolean {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    let timestamps = this.windows.get(chatKey) ?? [];
    timestamps = timestamps.filter((t) => t > cutoff);
    if (timestamps.length >= MAX_MESSAGES) {
      this.windows.set(chatKey, timestamps);
      return false;
    }
    timestamps.push(now);
    this.windows.set(chatKey, timestamps);
    return true;
  }

  clear(chatKey: string): void {
    this.windows.delete(chatKey);
  }
}
