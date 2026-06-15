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
    this.sweep(cutoff);
    return true;
  }

  // Drop keys whose window has fully aged out so the map doesn't grow one entry
  // per distinct chat forever over long uptime.
  private sweep(cutoff: number): void {
    for (const [key, ts] of this.windows) {
      const newest = ts[ts.length - 1];
      if (newest === undefined || newest <= cutoff) {
        this.windows.delete(key);
      }
    }
  }

  clear(chatKey: string): void {
    this.windows.delete(chatKey);
  }
}
