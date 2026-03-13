export class SessionLock {
  private readonly locked = new Set<string>();

  tryAcquire(sessionId: string): boolean {
    if (this.locked.has(sessionId)) return false;
    this.locked.add(sessionId);
    return true;
  }

  release(sessionId: string): void {
    this.locked.delete(sessionId);
  }

  isLocked(sessionId: string): boolean {
    return this.locked.has(sessionId);
  }
}
