import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatSettingsSchema } from "@orc/core/chat";
import { loadConfig, resetConfig } from "@orc/core/config";
import { runSync } from "../session-watcher.js";
import { piAdapter } from "../sessions/pi.js";
import { req, setupTestApp, teardownTestApp } from "./helpers";

for (const retry of [false, true])
  test(`Pi chat streams and resumes through the API with native options and edit permissions (retry=${retry})`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "orc-pi-chat-"));
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir);
    let attempts = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (retry && ++attempts === 1)
          return Response.json({ error: { message: "fixture retry" } }, { status: 500 });
        const body = (await request.json()) as { messages: { role: string }[]; tools?: unknown[] };
        const tool = body.messages.some((message) => message.role === "tool");
        const delta =
          tool || !body.tools?.length
            ? { content: "Pi API reply" }
            : {
                tool_calls: [
                  {
                    index: 0,
                    id: "api-write",
                    type: "function",
                    function: {
                      name: "write",
                      arguments: JSON.stringify({
                        path: "proof.txt",
                        content: "edit permissions honored",
                      }),
                    },
                  },
                ],
              };
        const chunk = {
          id: "fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
        };
        return new Response(
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: tool ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "orc-fixture": {
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
            api: "openai-completions",
            apiKey: "fixture-local-only",
            models: [{ id: "fixture", contextWindow: 32000, maxTokens: 1000 }],
          },
        },
      }),
    );
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        compaction: { enabled: true, keepRecentTokens: 32, reserveTokens: 32 },
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 10 },
      }),
    );
    const app = setupTestApp();
    const config = loadConfig();
    config.rules.enabled = false;
    config.preferences.chat = ChatSettingsSchema.parse({
      agent: "pi",
      mcp: "native",
      model: "orc-fixture/fixture",
    });
    config.providers = {
      instances: [
        {
          id: "pi-api-fixture",
          name: "Pi API fixture",
          agent: "pi",
          enabled: true,
          executable: fileURLToPath(
            new URL(
              "../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
              import.meta.resolve("@orc/agent-runtime"),
            ),
          ),
          model: "orc-fixture/fixture",
          environment: [{ name: "PI_CODING_AGENT_DIR", value: agentDir, secret: false }],
        },
      ],
      default_id: "pi-api-fixture",
    };
    try {
      const models = await req(
        app,
        "GET",
        `/chat/models?agent=pi&providerId=pi-api-fixture&cwd=${encodeURIComponent(cwd)}`,
      );
      expect(models.status).toBe(200);
      expect((await models.json()).models).toContainEqual({
        id: "orc-fixture/fixture",
        label: "fixture",
      });
      const turn = async (threadId?: string, compact = false) => {
        const response = await req(app, "POST", "/chat/stream", {
          agent: "pi",
          providerId: "pi-api-fixture",
          model: "orc-fixture/fixture",
          permissionMode: "acceptEdits",
          agentOptions: {
            pi: { runtime: "pi", options: { thinkingLevel: "off", autoRetry: retry } },
          },
          messages: [
            {
              role: "user",
              content: compact ? "/compact" : threadId ? "Continue" : "Write the proof file",
            },
          ],
          ...(threadId ? { threadId } : { workspace: { cwd, host: null, worktree: false } }),
        });
        expect(response.status).toBe(200);
        const text = await response.text();
        const events = text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => JSON.parse(line.slice(5)));
        expect(events.filter((event: { type: string }) => event.type === "error")).toEqual([]);
        if (!compact) expect(text).toContain("Pi API reply");
        return events;
      };
      const first = await turn();
      const threadId = first.find((event: { type: string }) => event.type === "thread")?.thread.id;
      expect(typeof threadId).toBe("string");
      expect(await Bun.file(join(cwd, "proof.txt")).text()).toBe("edit permissions honored");
      const original = await (await req(app, "GET", `/chat/threads/${threadId}`)).json();
      config.providers.instances.push({
        id: "codex",
        name: "Other default",
        agent: "codex",
        enabled: true,
        executable: "",
        model: "",
        environment: [],
      });
      config.providers.default_id = "codex";
      await runSync([piAdapter(join(agentDir, "sessions"))], { force: true });
      const imported = await (await req(app, "GET", "/sessions/live?active=false&agent=pi")).json();
      const source = imported.sessions.find(
        (row: { session_id: string }) => row.session_id === original.runtimeId,
      );
      expect(source).toBeDefined();
      const transcript = await req(app, "GET", `/sessions/live/${source.id}/transcript`);
      expect(transcript.status).toBe(200);
      expect(JSON.stringify(await transcript.json())).toContain("Pi API reply");
      const opened = await req(app, "POST", "/chat/threads", { sourceSessionId: source.id });
      expect(opened.status).toBe(200);
      const resumed = await opened.json();
      expect(resumed.runtimeId).toBe(original.runtimeId);
      expect(resumed.config.providerId).toBe("pi-api-fixture");
      expect(
        resumed.messages.some((message: { content: string }) =>
          message.content.includes("Pi API reply"),
        ),
      ).toBe(true);
      const resumedEvents = await turn(resumed.id);
      expect(
        resumedEvents.find((event: { type: string }) => event.type === "session")?.runtimeId,
      ).toBe(original.runtimeId);
      await turn(threadId);
      await turn(threadId, true);
    } finally {
      await server.stop(true);
      teardownTestApp();
      resetConfig();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30000);
