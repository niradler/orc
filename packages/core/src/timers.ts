/** setTimeout fires delays above 2^31-1 ms (~24.8 days) immediately instead of waiting. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export interface LongTimeout {
  clear(): void;
}

/** setTimeout for delays of any length: waits beyond the platform cap are chained. */
export function setLongTimeout(fn: () => void, delayMs: number): LongTimeout {
  const due = Date.now() + Math.max(0, delayMs);
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    const remaining = due - Date.now();
    timer =
      remaining > MAX_TIMER_DELAY_MS
        ? setTimeout(arm, MAX_TIMER_DELAY_MS)
        : setTimeout(fn, Math.max(0, remaining));
  };
  arm();
  return { clear: () => clearTimeout(timer) };
}
