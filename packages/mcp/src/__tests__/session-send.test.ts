import { afterAll, beforeAll, expect, test } from "bun:test";
import { resetConfig } from "@orc/core/config";
import { SessionMessageResultSchema } from "@orc/core/session-messages";
import { executeTool } from "../tools.js";

let server: ReturnType<typeof Bun.serve>;
let request: { path: string; session: string | null; mode: string | undefined } | undefined;
const originalBase = process.env.ORC_API_BASE;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { session_id: string; body: string; mode?: string };
      const session = req.headers.get("X-ORC-Session");
      request = {
        path: new URL(req.url).pathname,
        session,
        mode: body.mode,
      };
      return Response.json(
        SessionMessageResultSchema.parse({
          message: {
            id: "01J00000000000000000000000",
            project_id: null,
            target_session_id: body.session_id,
            target_native_id: "native-target",
            target_backend: "claude",
            sender_kind: session ? "session" : "human",
            sender_session_id: session,
            sender_native_id: session ? "native-sender" : null,
            sender_backend: session ? "claude" : null,
            sender_label: session ? `session ${session} (claude)` : "human relay (ORC web)",
            body: body.body,
            position: 0,
            hop: session ? 1 : 0,
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
  const parsed = JSON.parse(output);
  expect(parsed.message.sender_kind).toBe("session");
  expect(parsed.message.sender_session_id).toBe("sender");
  expect(output).toContain("Please review.");
});

test("falls back to human relay for queue when unbound", async () => {
  const output = await executeTool(
    "session_send",
    { session_id: "target", body: "Queued without binding" },
    { agentSessionId: null },
  );
  expect(request?.path).toBe("/api/session-messages");
  expect(request?.session).toBeNull();
  const parsed = JSON.parse(output);
  expect(parsed.message.sender_kind).toBe("human");
  expect(parsed.message.sender_session_id).toBeNull();
});

test("refuses steer and interrupt without a calling session identity", async () => {
  for (const mode of ["steer", "interrupt"] as const) {
    await expect(
      executeTool(
        "session_send",
        { session_id: "target", body: "hello", mode },
        { agentSessionId: null },
      ),
    ).rejects.toThrow(/requires a bound calling session identity/);
  }
});
