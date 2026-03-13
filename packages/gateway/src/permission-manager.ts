const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

type PendingPermission = {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class PermissionManager {
  private readonly pending = new Map<string, PendingPermission>();

  waitFor(id: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve(false);
        }
      }, PERMISSION_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
    });
  }

  resolve(id: string, approved: boolean): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(approved);
    return true;
  }

  denyAll(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve(false);
      this.pending.delete(id);
    }
  }

  hasPending(id: string): boolean {
    return this.pending.has(id);
  }
}
