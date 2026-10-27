import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@orc/agent-runtime";

const home = mkdtempSync(join(tmpdir(), "orc-attention-e2e-"));
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  ORC_DB_PATH: ":memory:",
  ORC_API_SECRET: "attention-fixture-secret",
  ORC_ACTIVE_PROJECT: "",
  ORC_SSH_HOST: "",
  ORC_RULES_ENABLED: "false",
  ORC_E2E_CHAT_MOCK: "",
});
const { resetConfig } = await import("../../../core/src/config.js");
resetConfig();
const { createTestDb } = await import("../../../db/src/client.js");
createTestDb();
const { createApp } = await import("../../../api/src/server.js");
const { registerBackend } = await import("../../../agent-runtime/src/index.js");
const { runSync } = await import("../../../api/src/session-watcher.js");
let observed = false;
const adapter = {
  backend: "codex",
  minIntervalMs: 0,
  list: async () => [
    {
      backend: "codex",
      externalId: "fixture-native",
      title: "Observed coding session",
      status: "running" as const,
      pendingHuman: observed,
      cwd: home,
      createdAt: new Date(),
      lastActivityAt: new Date(),
    },
  ],
};
await runSync([adapter], { force: true });
function session(): AgentSession {
  let secret = false;
  let finish = (_value: string) => {};
  const response = new Promise<string>((resolve) => {
    finish = resolve;
  });
  return {
    id: crypto.randomUUID(),
    getRuntimeSessionId: () => "fixture-native",
    send: async (prompt) => {
      secret = prompt.includes("private");
    },
    alive: () => true,
    close: async () => {
      finish("closed");
    },
    respondPermission: (_id, result) => {
      finish(result);
    },
    respondQuestion: (_id, _answers) => {
      finish("answered");
    },
    async *events() {
      if (secret)
        yield {
          type: "question_request",
          data: {
            requestId: "fixture-question",
            questions: [
              {
                id: "secret",
                header: "Secret",
                question: "Private fixture question",
                isSecret: true,
                options: [],
              },
            ],
          },
        };
      else
        yield {
          type: "permission_request",
          data: {
            requestId: "fixture-approval",
            tool: "command",
            command: "fixture harmless action",
          },
        };
      const result = await response;
      yield { type: "text", data: `Fixture response: ${result}` };
      yield { type: "result", data: { runtimeSessionId: "fixture-native" } };
    },
  };
}
registerBackend("codex-cli", () => ({
  name: "codex-cli",
  preflight: async () => ({ ok: true }),
  stop: async () => {},
  startSession: async () => session(),
  resumeSession: async () => session(),
}));
const app = createApp();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 255,
  async fetch(request) {
    if (new URL(request.url).pathname === "/fixture/observed" && request.method === "POST") {
      if (request.headers.get("authorization") !== "Bearer attention-fixture-secret")
        return new Response("Unauthorized", { status: 401 });
      observed = (await request.text()) === "true";
      await runSync([adapter], { force: true });
      return new Response("ok");
    }
    return app.fetch(request);
  },
});
console.log(`ATTENTION_FIXTURE ${server.url.origin}`);
setTimeout(() => {
  server.stop(true);
  process.exit(0);
}, 300000);
