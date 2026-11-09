export type PreviewCompletion = {
  status: "opened" | "completed" | "failed";
  error: string | null;
  result?: unknown;
};

/** Retry acknowledgements after a network failure, never the browser action itself. */
export class PreviewExecutionLedger {
  private readonly entries = new Map<
    string,
    { promise: Promise<PreviewCompletion>; done: boolean }
  >();
  run(id: string, execute: () => Promise<PreviewCompletion>): Promise<PreviewCompletion> {
    const existing = this.entries.get(id);
    if (existing) return existing.promise;
    if (this.entries.size >= 64) {
      for (const [key, value] of this.entries) {
        if (value.done) {
          this.entries.delete(key);
          break;
        }
      }
    }
    if (this.entries.size >= 64) throw new Error("Too many preview actions are still running");
    const entry = {
      done: false,
      promise: Promise.resolve<PreviewCompletion>({ status: "failed", error: "Not started" }),
    };
    entry.promise = Promise.resolve()
      .then(execute)
      .catch((cause) => ({
        status: "failed" as const,
        error: (cause instanceof Error ? cause.message : "Preview action failed").slice(0, 2000),
      }))
      .then((completion) => {
        entry.done = true;
        return completion;
      });
    this.entries.set(id, entry);
    return entry.promise;
  }
}
