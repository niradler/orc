import { afterEach, test as bunTest, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiSession } from "../pi";
import type { AgentEvent, SessionOpts } from "../types";

const piCli = join(
  dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  "bundle",
  "cli.js",
);
const test = bunTest.skipIf(
  !Bun.which("node") || Bun.spawnSync(["node", piCli, "--version"]).exitCode !== 0,
);

const owned: { cwd: string; session: PiSession }[] = [];
afterEach(async () => {
  const items = owned.splice(0);
  for (const item of items) await item.session.close();
  for (const cwd of new Set(items.map((item) => item.cwd)))
    rmSync(cwd, { recursive: true, force: true });
});
function fixture(opts: Partial<SessionOpts> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "orc-pi-real-"));
  const extension = join(cwd, "probe.mjs");
  writeFileSync(
    extension,
    `export default function(pi) {
    pi.registerCommand('probe', {description:'RPC integration probe', handler:async(args,ctx)=>{
      if(args==='proxy')pi.sendUserMessage('Reply to the proxied request');
      if(args==='reload')await ctx.reload();
      if(args==='fresh'){const result=await ctx.newSession();ctx.ui.notify('replacement-cancelled:'+result.cancelled);}
      if(args==='identity')ctx.ui.notify('native-id:'+ctx.sessionManager.getSessionId());
      if(args==='mcp')ctx.ui.notify('mcp-tools:'+pi.getAllTools().filter(tool=>tool.name.startsWith('mcp__orc_')).map(tool=>tool.name).join(','));
      if(args==='dialog') {const answer=await ctx.ui.input('Your answer');ctx.ui.notify('answer:'+answer);}
      if(args==='permission') {const tool={toolName:'write',input:{path:'proof.txt',content:'proof'}};const allowed=await ctx.ui.confirm('ORC tool approval',JSON.stringify({tool:tool.toolName,input:tool.input}));ctx.ui.notify('approved:'+allowed);}
      if(args==='slow'){ctx.ui.notify('slow-started');await new Promise(resolve=>setTimeout(resolve,200));ctx.ui.notify('slow-ended');}
      if(args==='slowlong'){ctx.ui.notify('slow-started');await new Promise(resolve=>setTimeout(resolve,3500));ctx.ui.notify('slow-ended');}
      if(args==='broken')throw new Error('extension deliberately failed');
      if(args==='shutdown')pi.on('session_shutdown',async(_event,c)=>await c.ui.confirm('Exit?','Confirm shutdown')); 
    }});
  }`,
  );
  const session = new PiSession({
    cwd,
    orcMcp: false,
    providerExecutable: piCli,
    env: { PI_CODING_AGENT_DIR: join(cwd, "agent") },
    ...opts,
  });
  mkdirSync(join(cwd, "agent"), { recursive: true });
  writeFileSync(join(cwd, "agent", "settings.json"), JSON.stringify({ extensions: [extension] }));
  owned.push({ cwd, session });
  return { cwd, session, extension };
}
async function collect(session: PiSession) {
  const events: AgentEvent[] = [];
  for await (const event of session.events()) {
    events.push(event);
    if (event.type === "question_request")
      session.respondQuestion(event.data.requestId, { answer: ["from ORC"] });
    if (event.type === "permission_request")
      session.respondPermission(event.data.requestId, "denied");
  }
  return events;
}
test("real Pi initializes the typed RPC bridge and closes without leaking processes", async () => {
  const { session } = fixture();
  await session.initialize();
  expect(session.alive()).toBe(true);
  expect(session.getRuntimeSessionId()).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/);
  await session.close();
  expect(session.alive()).toBe(false);
}, 30000);

test("real Pi exposes extension questions before a handled command response", async () => {
  const { session } = fixture();
  await session.initialize();
  const sent = session.send("/probe dialog");
  await expect(
    Promise.race([
      sent,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("send blocked the event consumer")), 1000),
      ),
    ]),
  ).resolves.toBeUndefined();
  const events = await collect(session);
  expect(events.some((e) => e.type === "question_request")).toBe(true);
  expect(events.some((e) => e.type === "system_status" && e.data === "answer:from ORC")).toBe(true);
  expect(events.filter((e) => e.type === "result")).toHaveLength(1);
}, 15000);

test("real Pi handles a denied approval and supports subsequent turns", async () => {
  const { session } = fixture();
  await session.initialize();
  await session.send("/probe permission");
  const first = await collect(session);
  expect(first.some((e) => e.type === "permission_request")).toBe(true);
  expect(first.some((e) => e.type === "system_status" && e.data === "approved:false")).toBe(true);
  await session.send("/probe dialog");
  const second = await collect(session);
  expect(second.some((e) => e.type === "system_status" && e.data === "answer:from ORC")).toBe(true);
}, 15000);

test("real Pi streams a model turn, gates writes, reports usage and resumes the native session", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const messages = body.messages as { role: string }[];
      const hasTool = messages.some((m) => m.role === "tool");
      const delta = hasTool
        ? { content: "Finished from real Pi" }
        : {
            tool_calls: [
              {
                index: 0,
                id: "write-proof",
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({ path: "proof.txt", content: "should be denied" }),
                },
              },
            ],
          };
      const chunks = [
        { choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: hasTool ? "stop" : "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ];
      return new Response(
        `${chunks
          .map(
            (chunk) =>
              "data: " +
              JSON.stringify({
                id: "fixture",
                object: "chat.completion.chunk",
                created: 1,
                model: "fixture",
                ...chunk,
              }) +
              "\n\n",
          )
          .join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const { session, cwd } = fixture({ model: "orc-fixture/fixture" });
  writeFileSync(
    join(cwd, "agent", "models.json"),
    JSON.stringify({
      providers: {
        "orc-fixture": {
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          api: "openai-completions",
          apiKey: "fixture-local-only",
          models: [
            {
              id: "fixture",
              name: "Fixture",
              input: ["text", "image"],
              contextWindow: 32000,
              maxTokens: 1000,
            },
          ],
        },
      },
    }),
  );
  try {
    await session.initialize();
    await session.send("Write the proof file");
    const events = await collect(session);
    expect(events.some((e) => e.type === "permission_request" && e.data.tool === "Write")).toBe(
      true,
    );
    expect(events.some((e) => e.type === "tool_result" && e.data.isError)).toBe(true);
    expect(events.some((e) => e.type === "text" && e.data === "Finished from real Pi")).toBe(true);
    expect(events.find((e) => e.type === "result")?.data).toMatchObject({
      outcome: "completed",
      usage: { input: 20, output: 10 },
    });
    expect(await Bun.file(join(cwd, "proof.txt")).exists()).toBe(false);
    const runtimeSessionId = session.getRuntimeSessionId();
    if (!runtimeSessionId) throw new Error("Missing native Pi session");
    await session.close();
    const resumed = new PiSession({
      cwd,
      orcMcp: false,
      model: "orc-fixture/fixture",
      runtimeSessionId,
      providerExecutable: piCli,
      env: { PI_CODING_AGENT_DIR: join(cwd, "agent") },
    });
    owned.push({ cwd, session: resumed });
    await resumed.initialize();
    expect(resumed.getRuntimeSessionId()).toBe(runtimeSessionId);
    await resumed.send("Continue");
    expect((await collect(resumed)).some((e) => e.type === "text")).toBe(true);
    expect(requests.length).toBeGreaterThanOrEqual(3);
  } finally {
    await session.close();
    await server.stop(true);
  }
}, 30000);

for (const reload of [false, true])
  test(`real Pi preserves scoped authenticated MCP and native settings (reload=${reload})`, async () => {
    const { resetConfig } = await import("@orc/core/config");
    const captured: { url: string; authorization: string | null }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method === "GET") return new Response(null, { status: 405 });
        const m = (await request.json()) as {
          id?: string | number;
          method: string;
          params?: { protocolVersion: string };
        };
        captured.push({ url: request.url, authorization: request.headers.get("authorization") });
        if (m.id === undefined) return new Response(null, { status: 202 });
        const result =
          m.method === "initialize"
            ? {
                protocolVersion: m.params?.protocolVersion,
                serverInfo: { name: "fixture", version: "1" },
                capabilities: { tools: {} },
              }
            : m.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "ping",
                      description: "Fixture ping",
                      inputSchema: { type: "object", properties: {} },
                    },
                  ],
                }
              : {};
        return Response.json({ jsonrpc: "2.0", id: m.id, result });
      },
    });
    const savedPort = process.env.ORC_API_PORT;
    const savedSecret = process.env.ORC_API_SECRET;
    process.env.ORC_API_PORT = String(server.port);
    process.env.ORC_API_SECRET = "pi-fixture-private-token";
    resetConfig();
    const { session, cwd } = fixture({ orcMcp: true, orcMcpProject: "Pi integration fixture" });
    try {
      const before = await Bun.file(join(cwd, "agent", "settings.json")).text();
      await session.initialize();
      if (reload) {
        await session.send("/probe reload");
        await collect(session);
      }
      await session.send("/probe mcp");
      const mcpEvents = await collect(session);
      expect(
        mcpEvents.some(
          (event) =>
            event.type === "system_status" &&
            event.data.includes(`mcp__orc_${session.id.toLowerCase()}__ping`),
        ),
      ).toBe(true);
      expect(captured.length).toBeGreaterThanOrEqual(2);
      expect(captured.every((row) => row.authorization === "Bearer pi-fixture-private-token")).toBe(
        true,
      );
      expect(
        captured.some(
          (row) => new URL(row.url).searchParams.get("project") === "Pi integration fixture",
        ),
      ).toBe(true);
      expect(await Bun.file(join(cwd, "agent", "settings.json")).text()).toBe(before);
      expect(await Bun.file(join(cwd, "agent", "mcp.json")).exists()).toBe(false);
      expect(await Bun.file(join(cwd, ".pi", "mcp.json")).exists()).toBe(false);
    } finally {
      await session.close();
      await server.stop(true);
      if (savedPort === undefined) delete process.env.ORC_API_PORT;
      else process.env.ORC_API_PORT = savedPort;
      if (savedSecret === undefined) delete process.env.ORC_API_SECRET;
      else process.env.ORC_API_SECRET = savedSecret;
      resetConfig();
    }
  }, 30000);

test("real Pi sends images, steers before the next model request, and applies live edit permissions", async () => {
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string; content: unknown }[] };
      requests.push(body);
      const hasTool = body.messages.some((m) => m.role === "tool");
      const delta = hasTool
        ? { content: "Image and steering received" }
        : {
            tool_calls: [
              {
                index: 0,
                id: "write-approved",
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({ path: "allowed.txt", content: "approved" }),
                },
              },
            ],
          };
      return new Response(
        "data: " +
          JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }],
          }) +
          "\n\ndata: " +
          JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [{ index: 0, delta: {}, finish_reason: hasTool ? "stop" : "tool_calls" }],
          }) +
          "\n\ndata: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const { session, cwd } = fixture({
    model: "orc-fixture/fixture",
    chatAgentOptions: {
      runtime: "pi",
      options: { thinkingLevel: "off", autoRetry: false, autoCompaction: false },
    },
  });
  writeFileSync(
    join(cwd, "agent", "models.json"),
    JSON.stringify({
      providers: {
        "orc-fixture": {
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          api: "openai-completions",
          apiKey: "fixture-local-only",
          models: [
            { id: "fixture", input: ["text", "image"], contextWindow: 32000, maxTokens: 1000 },
          ],
        },
      },
    }),
  );
  try {
    await session.initialize();
    await session.send("Look at the image then write the file", [
      {
        data: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
        mimeType: "image/png",
      },
    ]);
    let approval = false;
    for await (const event of session.events())
      if (event.type === "permission_request") {
        approval = true;
        await session.steer("Steered instruction from ORC");
        session.setPermissionMode("acceptEdits");
      }
    expect(approval).toBe(true);
    expect(await Bun.file(join(cwd, "allowed.txt")).text()).toBe("approved");
    expect(JSON.stringify(requests[0])).toContain("image_url");
    expect(JSON.stringify(requests.at(-1))).toContain("Steered instruction from ORC");
  } finally {
    await session.close();
    await server.stop(true);
  }
}, 30000);

test("real Pi cooperatively stops an active request and rejects an unrelated resume identity", async () => {
  let received!: () => void;
  const started = new Promise<void>((resolve) => {
    received = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      received();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": waiting\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const { session, cwd } = fixture({ model: "orc-fixture/fixture" });
  writeFileSync(
    join(cwd, "agent", "models.json"),
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
  try {
    await session.initialize();
    await session.send("Wait for cancellation");
    await started;
    await session.steer("Must not run after stop");
    await session.interrupt();
    const events = await collect(session);
    expect(events.find((e) => e.type === "result")?.data).toMatchObject({ outcome: "stopped" });
    expect(session.alive()).toBe(true);
    const invalid = new PiSession({
      cwd,
      orcMcp: false,
      runtimeSessionId: join(cwd, "nonexistent.jsonl"),
      providerExecutable: piCli,
      env: { PI_CODING_AGENT_DIR: join(cwd, "agent") },
    });
    owned.push({ cwd, session: invalid });
    await expect(invalid.initialize()).rejects.toThrow();
    expect(invalid.alive()).toBe(false);
  } finally {
    await session.close();
    await server.stop(true);
  }
}, 30000);

test("Pi stop drains handled extension commands before another question turn", async () => {
  const { session } = fixture();
  await session.initialize();
  await session.send("/probe slow");
  for await (const event of session.events())
    if (event.type === "system_status" && event.data === "slow-started") break;
  await session.interrupt();
  expect(
    (await collect(session)).some((e) => e.type === "result" && e.data.outcome === "stopped"),
  ).toBe(true);
  await session.send("/probe dialog");
  const events = await collect(session);
  expect(events.some((e) => e.type === "system_status" && e.data === "answer:from ORC")).toBe(true);
}, 15000);

test("real Pi resumes the same native session after an interrupt-Stop", async () => {
  let received!: () => void;
  const started = new Promise<void>((resolve) => {
    received = resolve;
  });
  let requestCount = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requestCount++;
      // The first model request hangs so the turn can be stopped mid-flight; later
      // requests (the resumed turn) reply normally.
      if (requestCount === 1) {
        received();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(": waiting\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const chunks = [
        {
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Resumed after stop" },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ];
      return new Response(
        `${chunks
          .map(
            (chunk) =>
              "data: " +
              JSON.stringify({
                id: "fixture",
                object: "chat.completion.chunk",
                created: 1,
                model: "fixture",
                ...chunk,
              }) +
              "\n\n",
          )
          .join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const { session, cwd } = fixture({ model: "orc-fixture/fixture" });
  writeFileSync(
    join(cwd, "agent", "models.json"),
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
  try {
    await session.initialize();
    const runtimeSessionId = session.getRuntimeSessionId();
    expect(runtimeSessionId).toBeTruthy();
    await session.send("Stop this turn");
    await started;
    await session.interrupt();
    expect(
      (await collect(session)).some((e) => e.type === "result" && e.data.outcome === "stopped"),
    ).toBe(true);
    expect(session.getRuntimeSessionId()).toBe(runtimeSessionId);
    // The chat runtime closes the per-turn transport after a Stop, then the next send
    // resumes the native session; prove that resume continues the same identity.
    await session.close();
    const resumed = new PiSession({
      cwd,
      orcMcp: false,
      model: "orc-fixture/fixture",
      runtimeSessionId,
      providerExecutable: piCli,
      env: { PI_CODING_AGENT_DIR: join(cwd, "agent") },
    });
    owned.push({ cwd, session: resumed });
    await resumed.initialize();
    expect(resumed.getRuntimeSessionId()).toBe(runtimeSessionId);
    await resumed.send("Continue");
    expect(
      (await collect(resumed)).some((e) => e.type === "text" && e.data === "Resumed after stop"),
    ).toBe(true);
  } finally {
    await session.close();
    await server.stop(true);
  }
}, 30000);

for (const command of ["slow", "slowlong"])
  test(`Pi reports no resumable session after an interrupted /probe ${command} turn`, async () => {
    const { session, cwd } = fixture();
    try {
      await session.initialize();
      const rawId = session.getRuntimeSessionId();
      expect(rawId).toBeTruthy();
      await session.send(`/probe ${command}`);
      for await (const event of session.events())
        if (event.type === "system_status" && event.data === "slow-started") break;
      await session.interrupt();
      const result = (await collect(session)).find((e) => e.type === "result") as
        | Extract<AgentEvent, { type: "result" }>
        | undefined;
      // An extension-command turn appends no transcript message, so Pi never persists
      // the session. The result must say so instead of handing out a non-resumable id.
      expect(result?.data).toMatchObject({ outcome: "stopped", resumable: false });
      expect(result?.data.runtimeSessionId).toBeUndefined();
      await session.close();
      // Proves the session was never written: resuming that exact id fails.
      const resume = new PiSession({
        cwd,
        orcMcp: false,
        runtimeSessionId: rawId,
        providerExecutable: piCli,
        env: { PI_CODING_AGENT_DIR: join(cwd, "agent") },
      });
      owned.push({ cwd, session: resume });
      await expect(resume.initialize()).rejects.toThrow();
      // The next send starts a fresh native session and continues working.
      const fresh = new PiSession({
        cwd,
        orcMcp: false,
        providerExecutable: piCli,
        env: { PI_CODING_AGENT_DIR: join(cwd, "agent") },
      });
      owned.push({ cwd, session: fresh });
      await fresh.initialize();
      await fresh.send("/probe identity");
      expect(
        (await collect(fresh)).some(
          (e) => e.type === "system_status" && String(e.data).startsWith("native-id:"),
        ),
      ).toBe(true);
    } finally {
      await session.close();
    }
  }, 30000);

test("Pi reports no resumable session after a completed extension-command turn", async () => {
  const { session } = fixture();
  try {
    await session.initialize();
    await session.send("/probe dialog");
    const result = (await collect(session)).find((e) => e.type === "result") as
      | Extract<AgentEvent, { type: "result" }>
      | undefined;
    expect(result?.data).toMatchObject({ outcome: "completed", resumable: false });
    expect(result?.data.runtimeSessionId).toBeUndefined();
  } finally {
    await session.close();
  }
}, 15000);

test("Pi closes safely when an extension asks a shutdown question", async () => {
  const { session } = fixture();
  await session.initialize();
  await session.send("/probe shutdown");
  await collect(session);
  await session.close();
  expect(session.alive()).toBe(false);
}, 15000);

test("Pi reports handled extension failures as failed turns", async () => {
  const { session } = fixture();
  await session.initialize();
  await session.send("/probe broken");
  const events = await collect(session);
  expect(
    events.some((e) => e.type === "error" && e.data.includes("extension deliberately failed")),
  ).toBe(true);
  expect(events.find((e) => e.type === "result")?.data).toMatchObject({ outcome: "failed" });
}, 15000);

test("Pi accepts ORC appended system instructions", async () => {
  const { chatSystemPrompt } = await import("@orc/core/chat");
  const { session } = fixture({
    systemPromptAppend: chatSystemPrompt("Operator instructions", { webchat: true }),
  });
  await session.initialize();
  expect(session.alive()).toBe(true);
}, 15000);

test("real Pi settles after retry recovery and streams reasoning separately", async () => {
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      if (++calls === 1)
        return Response.json({ error: { message: "fixture transient error" } }, { status: 500 });
      const chunk = {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
      };
      return new Response(
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Native reasoning" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { content: "Recovered reply" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const { session, cwd, extension } = fixture({
    model: "orc-fixture/fixture",
    chatAgentOptions: { runtime: "pi", options: { autoRetry: true, thinkingLevel: "high" } },
  });
  writeFileSync(
    join(cwd, "agent", "models.json"),
    JSON.stringify({
      providers: {
        "orc-fixture": {
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          api: "openai-completions",
          apiKey: "fixture-local-only",
          models: [{ id: "fixture", reasoning: true, contextWindow: 32000, maxTokens: 1000 }],
        },
      },
    }),
  );
  writeFileSync(
    join(cwd, "agent", "settings.json"),
    JSON.stringify({
      extensions: [extension],
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 10 },
    }),
  );
  try {
    await session.initialize();
    await session.send("Recover and think");
    const events = await collect(session);
    expect(events.some((e) => e.type === "system_status" && e.data.includes("retrying"))).toBe(
      true,
    );
    expect(events.some((e) => e.type === "thinking" && e.data === "Native reasoning")).toBe(true);
    expect(events.some((e) => e.type === "text" && e.data === "Recovered reply")).toBe(true);
    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
    expect(events.find((e) => e.type === "result")?.data).toMatchObject({ outcome: "completed" });
  } finally {
    await session.close();
    await server.stop(true);
  }
}, 30000);

test("Pi refuses native session replacement while preserving the ORC conversation", async () => {
  const { session } = fixture();
  await session.initialize();
  const original = session.getRuntimeSessionId();
  await session.send("/probe fresh");
  const replacement = await collect(session);
  expect(
    replacement.some((event) => event.type === "error" && event.data.includes("session")),
  ).toBe(true);
  await session.send("/probe identity");
  const identity = await collect(session);
  expect(
    identity.some(
      (event) => event.type === "system_status" && event.data === `native-id:${original}`,
    ),
  ).toBe(true);
  expect(session.getRuntimeSessionId()).toBe(original);
}, 15000);

test("Pi native queue, retry and compaction options retain their documented persisted behavior", async () => {
  const { session, cwd } = fixture({
    chatAgentOptions: {
      runtime: "pi",
      options: {
        steeringMode: "all",
        followUpMode: "all",
        autoRetry: false,
        autoCompaction: false,
      },
    },
  });
  await session.initialize();
  await session.close();
  const settings = await Bun.file(join(cwd, "agent", "settings.json")).json();
  expect(settings).toMatchObject({
    steeringMode: "all",
    followUpMode: "all",
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  expect(await Bun.file(join(cwd, "agent", "mcp.json")).exists()).toBe(false);
}, 15000);

test("Pi waits for model work started by a handled extension command", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      await Bun.sleep(100);
      return new Response(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Proxied reply" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const { session, cwd } = fixture({ model: "orc-fixture/fixture" });
  writeFileSync(
    join(cwd, "agent", "models.json"),
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
  try {
    await session.initialize();
    await session.send("/probe proxy");
    const events = await collect(session);
    expect(events.some((event) => event.type === "text" && event.data === "Proxied reply")).toBe(
      true,
    );
    expect(events.filter((event) => event.type === "result")).toHaveLength(1);
  } finally {
    await session.close();
    await server.stop(true);
  }
}, 15000);
