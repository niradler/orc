/** Navigation can replace Chromium's frame between readiness and an observational read. Never retry mutations. */
export async function previewObservation<T>(
  read: () => Promise<T>,
  assertAllowed: () => void,
  timeout = 10000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let failure: unknown;
  while (true) {
    assertAllowed();
    if (failure && Date.now() >= deadline) throw failure;
    try {
      const value = await read();
      assertAllowed();
      return value;
    } catch (cause) {
      assertAllowed();
      if (
        !(cause instanceof Error) ||
        !/Render frame was disposed|Execution context was destroyed|frame was detached|Cannot find context with specified id/i.test(
          cause.message,
        )
      )
        throw cause;
      failure = cause;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
