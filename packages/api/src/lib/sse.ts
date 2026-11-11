import type { Context } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";

const UNBUFFERED = { "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" };

// streamSSE overwrites Cache-Control, and Hono merges context headers over the returned response.
export function unbufferedSSE(
  c: Context,
  run: (stream: SSEStreamingApi) => Promise<void>,
): Response {
  const response = streamSSE(c, run);
  for (const [name, value] of Object.entries(UNBUFFERED)) {
    response.headers.set(name, value);
    c.header(name, value);
  }
  return response;
}
