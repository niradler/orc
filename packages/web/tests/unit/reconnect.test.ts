import { expect, test } from "bun:test";
import { MAX_RECONNECT_DELAY_MS, reconnectDelay, waitToReconnect } from "../../src/lib/reconnect";

test("backs off per consecutive failure and never stops retrying", () => {
  expect([1, 2, 3, 4].map(reconnectDelay)).toEqual([1000, 2000, 4000, 8000]);
  expect(reconnectDelay(50)).toBe(MAX_RECONNECT_DELAY_MS);
});

test("retries as soon as connectivity returns instead of waiting out the backoff", async () => {
  let wake = () => {};
  let unsubscribed = false;
  const started = performance.now();
  const waiting = waitToReconnect(60_000, new AbortController().signal, (next) => {
    wake = next;
    return () => {
      unsubscribed = true;
    };
  });
  wake();
  await waiting;
  expect(performance.now() - started).toBeLessThan(1000);
  expect(unsubscribed).toBe(true);
});

test("stops waiting when the stream is abandoned", async () => {
  const controller = new AbortController();
  const waiting = waitToReconnect(60_000, controller.signal, () => () => {});
  controller.abort();
  await waiting;
  const aborted = new AbortController();
  aborted.abort();
  await waitToReconnect(60_000, aborted.signal, () => () => {});
});
