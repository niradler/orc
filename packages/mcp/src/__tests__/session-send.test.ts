import { afterAll, beforeAll, expect, test } from "bun:test";
import { resetConfig } from "@orc/core/config";
import { SessionMessageResultSchema } from "@orc/core/session-messages";
import { executeTool } from "../tools.js";

let server: ReturnType<typeof Bun.serve>;
let request: { path: string; session: string | null } | undefined;
const originalBase = process.env.ORC_API_BASE;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { session_id: string; body: string };
      request = {
        path: new URL(req.url).pathname,
        session: req.headers.get("X-ORC-Session"),
      };
      return Response.json(
        SessionMessageResultSchema.parse({
          message: {
            id: "01J00000000000000000000000",
            project_id: null,
            target_session_id: body.session_id,
            target_native_id: "native-target",
            target_backend: "claude",
            sender_kind: "session",
            sender_session_id: "sender",
            sender_native_id: "native-sender",
            sender_backend: "claude",
            sender_label: "session sender (claude)",
            body: body.body,
            position: 0,
            hop: 1,
            state: "queued",
            delivered_via: null,
            delivery_error: null,
            request_id: null,
            created_at: 1,
            updated_at: 1,
            delivered_at: null,
          },
          target: {
            session_id: body.session_id,
            backend: "claude",
            status: "idle",
            delivery: "hook",
          },
        }),
      );
    },
  });
  process.env.ORC_API_BASE = String(server.url).replace(/\/$/, "");
  resetConfig();
});

afterAll(() => {
  server.stop(true);
  if (originalBase === undefined) delete process.env.ORC_API_BASE;
  else process.env.ORC_API_BASE = originalBase;
  resetConfig();
});

test("sends a message with the calling session identity", async () => {
  const output = await executeTool(
    "session_send",
    { session_id: "target", body: "Please review." },
    { agentSessionId: "sender" },
  );
  expect(request?.path).toBe("/api/session-messages");
  expect(request?.session).toBe("sender");
  expect(output).toContain("Please review.");
});

test("refuses to send without a calling session identity", async () => {
  await expect(
    executeTool("session_send", { session_id: "target", body: "hello" }, { agentSessionId: null }),
  ).rejects.toThrow(/needs the calling session identity/);
});
