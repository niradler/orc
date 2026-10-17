import { createRoute, z } from "@hono/zod-openapi";
import { type ChangeResource, changes } from "@orc/core/changes";
import { streamSSE } from "hono/streaming";
import { createRouter } from "../lib/router.js";
import { retainChangeSources } from "../realtime/sources.js";

const app = createRouter();

app.openapi(
  createRoute({
    method: "get",
    path: "/events",
    tags: ["System"],
    summary: "Shared resource-change event stream; fetch snapshots on ready and after reconnect",
    responses: {
      200: {
        description: "SSE ready/change events; comments are transport keepalives",
        content: { "text/event-stream": { schema: z.string() } },
      },
    },
  }),
  (c) => {
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      const release = retainChangeSources();
      const pending = new Set<ChangeResource>();
      let wake: (() => void) | undefined;
      let stopped = false;
      const unsubscribe = changes.subscribe(({ resources }) => {
        for (const resource of resources) pending.add(resource);
        wake?.();
      });
      stream.onAbort(() => {
        stopped = true;
        wake?.();
      });
      const heartbeat = setInterval(() => {
        wake?.();
      }, 25_000);
      try {
        await stream.writeSSE({ event: "ready", data: "{}" });
        while (!stopped) {
          if (!pending.size)
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          wake = undefined;
          if (stopped) break;
          if (pending.size) {
            const resources = [...pending];
            pending.clear();
            await stream.writeSSE({ event: "change", data: JSON.stringify({ resources }) });
          } else await stream.write(": keepalive\n\n");
        }
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
        release();
      }
    });
  },
);

export { app as eventsRouter };
