import { createRoute, z } from "@hono/zod-openapi";
import { type ChangeResource, changes } from "@orc/core/changes";
import { createRouter } from "../lib/router.js";
import { unbufferedSSE } from "../lib/sse.js";
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
    return unbufferedSSE(c, async (stream) => {
      const release = retainChangeSources();
      const pending = new Set<ChangeResource>();
      const scoped = new Set<ChangeResource>();
      const sessions = new Set<string>();
      let wake: (() => void) | undefined;
      let stopped = false;
      const unsubscribe = changes.subscribe((change) => {
        for (const resource of change.resources) (change.sessions ? scoped : pending).add(resource);
        for (const id of change.sessions ?? []) sessions.add(id);
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
          if (!pending.size && !scoped.size)
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          wake = undefined;
          if (stopped) break;
          if (pending.size || scoped.size) {
            const global = [...pending];
            const resources = [...scoped].filter((resource) => !pending.has(resource));
            const ids = [...sessions];
            pending.clear();
            scoped.clear();
            sessions.clear();
            if (global.length)
              await stream.writeSSE({
                event: "change",
                data: JSON.stringify({ resources: global }),
              });
            if (resources.length)
              await stream.writeSSE({
                event: "change",
                data: JSON.stringify({ resources, sessions: ids }),
              });
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
