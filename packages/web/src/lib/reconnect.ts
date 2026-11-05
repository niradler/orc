export const MAX_RECONNECT_DELAY_MS = 15_000;

export function reconnectDelay(failures: number): number {
  return Math.min(1000 * 2 ** Math.max(0, failures - 1), MAX_RECONNECT_DELAY_MS);
}

/** Resolves after `ms`, on abort, or as soon as a wake source reports the connection may be back. */
export function waitToReconnect(
  ms: number,
  signal: AbortSignal,
  subscribe: (wake: () => void) => () => void,
): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    unsubscribe = subscribe(done);
    if (signal.aborted) done();
  });
}
