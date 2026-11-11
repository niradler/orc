import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const outcome of ["success", "error", "cancel"]) {
  test(`should close the Claude SDK query after ${outcome}`, () => {
    const script = `
import { mock } from "bun:test";
let closed = 0;
let drained = false;
let streamCompleted = false;
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  HOOK_EVENTS: [],
  query: ({options}) => {
    const stream = (async function* () {
      yield {type:"system",subtype:"init",session_id:"query-fixture"};
      if (${JSON.stringify(outcome)} === "cancel") {
        await new Promise(resolve => options.abortController.signal.addEventListener("abort",resolve,{once:true}));
        return;
      }
      if (${JSON.stringify(outcome)} === "error") throw new Error("fixture stream failure");
      yield {type:"result",subtype:"success",session_id:"query-fixture",is_error:false,usage:{},duration_ms:1};
      await Bun.sleep(25);
      streamCompleted = true;
    })();
    return {
      [Symbol.asyncIterator]: () => stream,
      close: () => { closed++; },
      return: async () => { closed++; await Bun.sleep(25); drained=true; return stream.return(); },
    };
  },
}));
const {loadConfig} = await import(${JSON.stringify(new URL("../../../core/src/config.ts", import.meta.url).href)});
const config = loadConfig();
loadConfig({rules:{...config.rules,enabled:false},preferences:{}});
await import(${JSON.stringify(new URL("../claude-sdk.ts", import.meta.url).href)});
const {createBackend} = await import(${JSON.stringify(new URL("../registry.ts", import.meta.url).href)});
const session = await createBackend("claude").startSession({cwd:process.cwd(),orcMcp:false,executionHost:null});
try {
  await session.send("Fixture request");
  const reading = (async () => { const events = []; for await (const event of session.events()) events.push(event); return events; })();
  if (${JSON.stringify(outcome)} === "cancel") {
    await Bun.sleep(10);
    await session.close();
    if (!drained) throw new Error("close returned before SDK subprocess shutdown");
  }
  const events = await reading;
  if (closed !== 1) throw new Error("SDK query was not closed exactly once");
  if (!drained) throw new Error("Session finished before SDK shutdown drained");
  if (${JSON.stringify(outcome)} === "success" && !streamCompleted) throw new Error("Stopped consuming SDK output before process shutdown");
  const expected = ${JSON.stringify(outcome)} === "error" ? "error" : "result";
  if (${JSON.stringify(outcome)} !== "cancel" && !events.some(event => event.type === expected)) throw new Error("Missing normalized outcome");
  console.log("SDK cleanup verified");
} finally { await session.close(); }
`;
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: resolve(import.meta.dir, "../.."),
      timeout: 15000,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toMatchObject({
      exitCode: 0,
    });
    expect(result.stdout.toString()).toContain("SDK cleanup verified");
  });
}

test("should stream Claude text deltas once, separating text blocks around a tool call", () => {
  const script = `
import { mock } from "bun:test";
const start = { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
const delta = (text) => ({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
const assistant = (content) => ({ type: "assistant", message: { content } });
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  HOOK_EVENTS: [],
  query: ({options}) => {
    if (options.includePartialMessages !== true) throw new Error("partial messages were not requested");
    const stream = (async function* () {
      yield {type:"system",subtype:"init",session_id:"stream-fixture"};
      yield start; yield delta("Hel"); yield delta("lo");
      yield assistant([{ type: "text", text: "Hello" }, { type: "tool_use", id: "t1", name: "Bash", input: {} }]);
      yield start; yield delta("Done");
      yield assistant([{ type: "text", text: "Done" }]);
      yield {type:"result",subtype:"success",session_id:"stream-fixture",is_error:false,usage:{},duration_ms:1};
    })();
    return { [Symbol.asyncIterator]: () => stream, close: () => {}, return: async () => stream.return() };
  },
}));
const {loadConfig} = await import(${JSON.stringify(new URL("../../../core/src/config.ts", import.meta.url).href)});
const config = loadConfig();
loadConfig({rules:{...config.rules,enabled:false},preferences:{}});
await import(${JSON.stringify(new URL("../claude-sdk.ts", import.meta.url).href)});
const {createBackend} = await import(${JSON.stringify(new URL("../registry.ts", import.meta.url).href)});
const session = await createBackend("claude").startSession({cwd:process.cwd(),orcMcp:false,executionHost:null});
try {
  await session.send("Fixture request");
  const texts = [];
  for await (const event of session.events()) if (event.type === "text") texts.push(event.data);
  console.log(JSON.stringify(texts));
} finally { await session.close(); }
`;
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: resolve(import.meta.dir, "../.."),
    timeout: 15000,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toMatchObject({
    exitCode: 0,
  });
  expect(JSON.parse(result.stdout.toString().trim().split("\n").at(-1) ?? "[]")).toEqual([
    "Hel",
    "lo",
    "\n\n",
    "Done",
  ]);
});

test("should not repeat streamed main-thread text when a subagent tool call interleaves", () => {
  const script = `
import { mock } from "bun:test";
const start = { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
const delta = (text) => ({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  HOOK_EVENTS: [],
  query: () => {
    const stream = (async function* () {
      yield {type:"system",subtype:"init",session_id:"subagent-fixture"};
      yield start; yield delta("Working");
      yield { type: "assistant", parent_tool_use_id: "task-1", message: { content: [{ type: "tool_use", id: "sub-1", name: "Read", input: {} }] } };
      yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Working" }] } };
      yield {type:"result",subtype:"success",session_id:"subagent-fixture",is_error:false,usage:{},duration_ms:1};
    })();
    return { [Symbol.asyncIterator]: () => stream, close: () => {}, return: async () => stream.return() };
  },
}));
const {loadConfig} = await import(${JSON.stringify(new URL("../../../core/src/config.ts", import.meta.url).href)});
const config = loadConfig();
loadConfig({rules:{...config.rules,enabled:false},preferences:{}});
await import(${JSON.stringify(new URL("../claude-sdk.ts", import.meta.url).href)});
const {createBackend} = await import(${JSON.stringify(new URL("../registry.ts", import.meta.url).href)});
const session = await createBackend("claude").startSession({cwd:process.cwd(),orcMcp:false,executionHost:null});
try {
  await session.send("Fixture request");
  const texts = [];
  for await (const event of session.events()) if (event.type === "text") texts.push(event.data);
  console.log(JSON.stringify(texts));
} finally { await session.close(); }
`;
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: resolve(import.meta.dir, "../.."),
    timeout: 15000,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toMatchObject({
    exitCode: 0,
  });
  expect(JSON.parse(result.stdout.toString().trim().split("\n").at(-1) ?? "[]")).toEqual([
    "Working",
  ]);
});

test("should keep queued session messages when a resumed Claude query fails and deliver them through the prompt hook", () => {
  const script = `
import { mock } from "bun:test";
const prompts = [];
const hookOutputs = [];
let mode = "fail";
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  HOOK_EVENTS: ["UserPromptSubmit"],
  query: ({options}) => {
    prompts.push(options.systemPrompt.append);
    if (mode === "fail") throw new Error("spawn claude ENOENT");
    const stream = (async function* () {
      yield {type:"system",subtype:"init",session_id:"resume-fixture"};
      const hook = options.hooks.UserPromptSubmit[0].hooks[0];
      hookOutputs.push(await hook({hook_event_name:"UserPromptSubmit",session_id:"resume-fixture",prompt:"Fixture request",cwd:process.cwd(),transcript_path:""}, undefined, {signal: options.abortController.signal}));
      yield {type:"result",subtype:"success",session_id:"resume-fixture",is_error:false,usage:{},duration_ms:1};
    })();
    return { [Symbol.asyncIterator]: () => stream, close: () => {}, return: async () => stream.return() };
  },
}));
const {createTestDb, closeDb, getSqlite} = await import("@orc/db/client");
const {SessionMessageStore} = await import("@orc/db/session-messages");
createTestDb();
const sqlite = getSqlite();
sqlite.run("INSERT INTO bridge_chats (id, platform, chat_id) VALUES ('fixture-chat', 'test', 'fixture-chat')");
sqlite.run("INSERT INTO gateway_sessions (id, chat_id, backend, mode, runtime_session_id, status) VALUES ('fixture-session', 'fixture-chat', 'claude', 'direct', 'resume-fixture', 'idle')");
const store = new SessionMessageStore(sqlite);
const message = store.create({ session_id: "resume-fixture", body: "Use the compact layout." }, { kind: "human", label: "human relay (web)" });
const {loadConfig} = await import(${JSON.stringify(new URL("../../../core/src/config.ts", import.meta.url).href)});
const config = loadConfig();
loadConfig({rules:{...config.rules,enabled:false},preferences:{}});
await import(${JSON.stringify(new URL("../claude-sdk.ts", import.meta.url).href)});
const {createBackend} = await import(${JSON.stringify(new URL("../registry.ts", import.meta.url).href)});
const turn = async () => {
  const session = await createBackend("claude").resumeSession("resume-fixture", {cwd:process.cwd(),orcMcp:false,executionHost:null});
  try {
    await session.send("Fixture request");
    const events = [];
    for await (const event of session.events()) events.push(event.type);
    return events;
  } finally { await session.close(); }
};
try {
  const failed = await turn();
  const afterFailure = store.get(message.id).state;
  mode = "succeed";
  const succeeded = await turn();
  const delivered = store.get(message.id);
  console.log(JSON.stringify({
    failed: failed.includes("error"),
    afterFailure,
    promptLeaked: prompts.some((append) => append.includes("Use the compact layout.")),
    succeeded: succeeded.includes("result"),
    state: delivered.state,
    via: delivered.delivered_via,
    hookContext: JSON.stringify(hookOutputs).includes("Use the compact layout."),
  }));
} finally { closeDb(); }
`;
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: resolve(import.meta.dir, "../.."),
    timeout: 15000,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toMatchObject({
    exitCode: 0,
  });
  expect(JSON.parse(result.stdout.toString().trim().split("\n").at(-1) ?? "{}")).toEqual({
    failed: true,
    afterFailure: "queued",
    promptLeaked: false,
    succeeded: true,
    state: "delivered",
    via: "hook",
    hookContext: true,
  });
});
