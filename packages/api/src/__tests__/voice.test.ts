import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentEvent,
  type AgentSession,
  createBackend,
  registerBackend,
} from "@orc/agent-runtime";
import { resetConfig } from "@orc/core/config";
import { handleVoiceUpgrade, type VoiceSocketData, voiceWebsocket } from "../voice.js";
import { setupTestApp, teardownTestApp } from "./helpers.js";

const AUTH = { Authorization: "Bearer test-secret", "content-type": "application/json" };
const wav = readFileSync(
  join(import.meta.dir, "../../../gateway/src/__tests__/fixtures/dictation.wav"),
);
const speech = new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length));
const oldMock = process.env.ORC_E2E_CHAT_MOCK;

let app: ReturnType<typeof setupTestApp>;
let transcript = "add a retry to the deploy step";
let ttsDelayMs = 0;
let sttFails = false;
let ttsFails = false;
let heard: { size: number; header: string }[] = [];
let synthesized: string[] = [];
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/audio/transcriptions")) {
      if (sttFails) return new Response("model not loaded", { status: 500 });
      const file = (await request.formData()).get("file") as File;
      const bytes = new Uint8Array(await file.arrayBuffer());
      heard.push({ size: bytes.length, header: new TextDecoder().decode(bytes.slice(8, 16)) });
      return new Response(transcript);
    }
    const { input } = (await request.json()) as { input: string };
    synthesized.push(input);
    if (ttsFails) return new Response("tts down", { status: 500 });
    await Bun.sleep(ttsDelayMs);
    return new Response(new TextEncoder().encode(`audio:${input}`));
  },
});
let server: ReturnType<typeof Bun.serve<VoiceSocketData>>;

function configure(speechEnabled = true) {
  writeFileSync(
    join(process.env.ORC_HOME ?? "", "config.json"),
    JSON.stringify({
      speech: {
        enabled: speechEnabled,
        provider: "openai",
        openai: { base_url: `http://127.0.0.1:${provider.port}/v1` },
        // The clip ends with under a second of silence; keep the turn short
        // instead of depending on the product's conversational default.
        voice_mode: { silence_ms: 400 },
      },
      tts: {
        enabled: true,
        provider: "openai",
        openai: { base_url: `http://127.0.0.1:${provider.port}/v1` },
      },
    }),
  );
  resetConfig();
}

beforeAll(() => {
  process.env.ORC_E2E_CHAT_MOCK = "1";
  app = setupTestApp();
  server = Bun.serve<VoiceSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      return handleVoiceUpgrade(request, srv) ?? app.fetch(request);
    },
    websocket: voiceWebsocket,
  });
});

afterAll(() => {
  server.stop(true);
  provider.stop(true);
  teardownTestApp();
  if (oldMock === undefined) delete process.env.ORC_E2E_CHAT_MOCK;
  else process.env.ORC_E2E_CHAT_MOCK = oldMock;
});

beforeEach(() => {
  configure();
  transcript = "add a retry to the deploy step";
  ttsDelayMs = 0;
  sttFails = false;
  ttsFails = false;
  heard = [];
  synthesized = [];
});

async function chat(content: string, threadId?: string): Promise<string> {
  const res = await app.request("/api/chat/stream", {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({
      ...(threadId ? { threadId } : {}),
      messages: [{ role: "user", content }],
    }),
  });
  const thread = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)))
    .find((event) => event.type === "thread");
  return thread.thread.id;
}

async function thread(id: string) {
  return (await (await app.request(`/api/chat/threads/${id}`, { headers: AUTH })).json()) as {
    messages: { role: string; content: string; turn?: { outcome: string } }[];
  };
}

async function connect(threadId: string) {
  const res = await app.request(`/api/chat/threads/${threadId}/voice/ticket`, {
    method: "POST",
    headers: AUTH,
  });
  const { ticket } = (await res.json()) as { ticket: string };
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.port}/api/chat/threads/${threadId}/voice?ticket=${ticket}`,
  );
  ws.binaryType = "arraybuffer";
  const messages: Record<string, unknown>[] = [];
  const audio: string[] = [];
  const waiters: { type: string; resolve: () => void }[] = [];
  ws.onmessage = (event) => {
    if (typeof event.data !== "string") {
      audio.push(new TextDecoder().decode(event.data as ArrayBuffer));
      return;
    }
    const message = JSON.parse(event.data) as Record<string, unknown>;
    messages.push(message);
    for (const waiter of waiters.filter((w) => w.type === message.type)) waiter.resolve();
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("voice socket failed"));
  });
  const next = (type: string) =>
    messages.some((m) => m.type === type)
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiters.push({ type, resolve }));
  const say = (samples: Int16Array) => {
    const padded = new Int16Array(8000 + samples.length + 16_000);
    padded.set(samples, 8000);
    for (let offset = 0; offset < padded.length; offset += 320)
      ws.send(padded.slice(offset, offset + 320));
  };
  return { ws, messages, audio, next, say };
}

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100 && !(await check()); i++) await Bun.sleep(50);
}

test("a ticket is single use, bound to its conversation, and needs speech configured", async () => {
  const id = await chat("Reply with exactly: ok");
  const missing = await app.request("/api/chat/threads/nope/voice/ticket", {
    method: "POST",
    headers: AUTH,
  });
  expect(missing.status).toBe(404);
  configure(false);
  const off = await app.request(`/api/chat/threads/${id}/voice/ticket`, {
    method: "POST",
    headers: AUTH,
  });
  expect(off.status).toBe(409);
  configure();
  const { ticket } = (await (
    await app.request(`/api/chat/threads/${id}/voice/ticket`, { method: "POST", headers: AUTH })
  ).json()) as { ticket: string };
  const other = await fetch(
    `http://127.0.0.1:${server.port}/api/chat/threads/other/voice?ticket=${ticket}`,
    { headers: { Upgrade: "websocket", Connection: "Upgrade" } },
  );
  expect(other.status).toBe(401);
  const reused = await fetch(
    `http://127.0.0.1:${server.port}/api/chat/threads/${id}/voice?ticket=${ticket}`,
    { headers: { Upgrade: "websocket", Connection: "Upgrade" } },
  );
  expect(reused.status).toBe(401);
});

test("a spoken clip ends the turn on silence and is sent to the conversation", async () => {
  const id = await chat("Reply with exactly: ok");
  const voice = await connect(id);
  voice.say(speech);
  await voice.next("transcript");
  await until(async () => (await thread(id)).messages.length === 4);
  const { messages } = await thread(id);
  expect(voice.messages.map((m) => m.type)).toEqual([
    "ready",
    "speech_start",
    "speech_end",
    "transcript",
    "turn_started",
  ]);
  expect(heard).toHaveLength(1);
  expect(heard[0]?.header).toBe("WAVEfmt ");
  expect(heard[0]?.size).toBeGreaterThan(44 + speech.length * 2);
  expect(messages.slice(2).map((m) => [m.role, m.content])).toEqual([
    ["user", "add a retry to the deploy step"],
    ["assistant", "add a retry to the deploy step"],
  ]);
  voice.ws.close();
});

test("a filler-only or empty transcript changes nothing", async () => {
  const id = await chat("Reply with exactly: ok");
  const voice = await connect(id);
  for (const filler of ["Um.", ""]) {
    transcript = filler;
    voice.messages.length = 0;
    voice.say(speech);
    await voice.next("ignored");
  }
  await Bun.sleep(100);
  expect((await thread(id)).messages).toHaveLength(2);
  voice.ws.close();
});

test("speaking interrupts the running turn and sends the new request", async () => {
  const id = await chat("Reply with exactly: ok");
  const slow = app.request("/api/chat/stream", {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({
      threadId: id,
      messages: [{ role: "user", content: "Reply with exactly: late after 5000ms" }],
    }),
  });
  await until(async () => (await thread(id)).messages.length === 3);
  const voice = await connect(id);
  voice.say(speech);
  await (await slow).text();
  await until(async () => (await thread(id)).messages.length === 6);
  const { messages } = await thread(id);
  expect(messages.slice(2).map((m) => [m.role, m.turn?.outcome ?? null])).toEqual([
    ["user", null],
    ["assistant", "stopped"],
    ["user", null],
    ["assistant", "completed"],
  ]);
  expect(messages[4]?.content).toBe("add a retry to the deploy step");
  voice.ws.close();
});

test("speak streams one audio clip per sentence to the open voice socket", async () => {
  const id = await chat("Reply with exactly: ok");
  const off = await app.request(`/api/chat/threads/${id}/speak`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ text: "Nobody is listening." }),
  });
  expect(await off.json()).toEqual({ posted: false, spoken: false });
  const voice = await connect(id);
  const res = await app.request(`/api/chat/threads/${id}/speak`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ text: "Running the tests now. ```sh\nbun test\n``` Back soon!" }),
  });
  expect(await res.json()).toEqual({ posted: false, spoken: true });
  await until(async () => voice.audio.length === 2);
  expect(voice.messages.filter((m) => m.type === "speak")).toEqual([
    { type: "speak", id: "1", text: "Running the tests now.", format: "ogg" },
    { type: "speak", id: "2", text: "Back soon!", format: "ogg" },
  ]);
  expect(voice.audio).toEqual(["audio:Running the tests now.", "audio:Back soon!"]);
  voice.ws.close();
});

function burst(ms: number, amplitude: number) {
  const samples = new Int16Array((ms / 20) * 320);
  samples.fill(amplitude);
  return samples;
}

test("a brief burst during a reply is cancelled without stopping it", async () => {
  const id = await chat("Reply with exactly: ok");
  const voice = await connect(id);
  transcript = "";
  const res = await app.request(`/api/chat/threads/${id}/speak`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ text: "First sentence. Second sentence." }),
  });
  expect(await res.json()).toEqual({ posted: false, spoken: true });
  await until(async () => voice.audio.length === 2);
  voice.say(burst(200, 3000));
  await voice.next("speech_cancelled");
  expect(voice.messages.map((m) => m.type)).not.toContain("barge");
  expect(voice.audio).toEqual(["audio:First sentence.", "audio:Second sentence."]);
  voice.ws.close();
});

test("once the client played every clip, a normal turn replaces idle playback", async () => {
  const id = await chat("Reply with exactly: ok");
  const voice = await connect(id);
  transcript = "add a retry";
  await app.request(`/api/chat/threads/${id}/speak`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ text: "On it." }),
  });
  await until(async () => voice.audio.length === 1);
  const clip = voice.messages.find((m) => m.type === "speak") as { id: string };
  voice.ws.send(JSON.stringify({ type: "played", id: clip.id }));
  voice.say(burst(300, 300));
  await voice.next("transcript");
  expect(voice.messages.map((m) => m.type)).toEqual([
    "ready",
    "speak",
    "speech_start",
    "speech_end",
    "transcript",
  ]);
  voice.ws.close();
});

test("barge-in drops the rest of the speech", async () => {
  const id = await chat("Reply with exactly: ok");
  const voice = await connect(id);
  ttsDelayMs = 400;
  const speaking = app.request(`/api/chat/threads/${id}/speak`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ text: "First sentence. Second sentence. Third sentence." }),
  });
  await until(async () => synthesized.length > 0);
  await voice.next("speak");
  transcript = "";
  voice.say(burst(600, 3000));
  expect(await (await speaking).json()).toEqual({ posted: false, spoken: false });
  await voice.next("ignored");
  // The clip already streaming plays; everything after it is never sent.
  expect(voice.audio).toEqual(["audio:First sentence."]);
  expect(voice.messages.map((m) => m.type)).toContain("barge");
  voice.ws.close();
});

test("a spoken line during a turn is posted to the transcript as its own paragraph", async () => {
  const id = await chat("Reply with exactly: ok");
  const slow = app.request("/api/chat/stream", {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({
      threadId: id,
      messages: [{ role: "user", content: "Reply with exactly: done after 800ms" }],
    }),
  });
  await until(async () => (await thread(id)).messages.length === 3);
  const res = await app.request(`/api/chat/threads/${id}/speak`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ text: "Working on it." }),
  });
  expect(await res.json()).toEqual({ posted: true, spoken: false });
  await (await slow).text();
  expect((await thread(id)).messages.at(-1)?.content).toBe("Working on it.\n\ndone after 800ms");
});

for (const kind of ["approval", "question"] as const)
  test(`speech never stops a turn waiting for ${kind === "approval" ? "an approval" : "a question"}; voice says it needs the screen`, async () => {
    const id = await chat("Reply with exactly: ok");
    const backend = (
      (await (await app.request(`/api/chat/threads/${id}`, { headers: AUTH })).json()) as {
        backend: string;
      }
    ).backend;
    const original = createBackend(backend);
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stopped = 0;
    const session: AgentSession = {
      id: "voice-fixture",
      capabilities: original.capabilities,
      getRuntimeSessionId: () => "voice-native",
      send: async () => {},
      respondPermission: () => release(),
      respondQuestion: () => release(),
      interrupt: async () => {
        stopped++;
        release();
      },
      alive: () => true,
      close: async () => release(),
      async *events(): AsyncIterable<AgentEvent> {
        yield kind === "approval"
          ? {
              type: "permission_request",
              data: { requestId: "perm-1", tool: "Write", command: "Write note.txt" },
            }
          : {
              type: "question_request",
              data: {
                requestId: "q-1",
                questions: [{ id: "c", header: "Pick", question: "Which file?", options: null }],
              },
            };
        await released;
        yield { type: "text", data: "done" };
        yield { type: "result", data: { runtimeSessionId: "voice-native" } };
      },
    };
    registerBackend(backend, () => ({
      ...original,
      preflight: async () => ({ ok: true }),
      startSession: async () => session,
      resumeSession: async () => session,
    }));
    delete process.env.ORC_E2E_CHAT_MOCK;
    try {
      const stream = app.request("/api/chat/stream", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ threadId: id, messages: [{ role: "user", content: "write it" }] }),
      });
      let waiting: { thread_id: string; kind: string }[] = [];
      await until(async () => {
        waiting = (
          (await (await app.request("/api/chat/waiting", { headers: AUTH })).json()) as {
            waiting: typeof waiting;
          }
        ).waiting;
        return waiting.length > 0;
      });
      expect(waiting.map((w) => [w.thread_id, w.kind])).toEqual([[id, kind]]);
      const voice = await connect(id);
      voice.say(speech);
      await voice.next("transcript");
      await until(async () => voice.messages.some((m) => m.type === "speak"));
      expect(voice.messages.filter((m) => m.type === "speak")).toEqual([
        { type: "speak", id: "1", text: "It needs you on screen.", format: "ogg" },
      ]);
      const still = (await (await app.request("/api/chat/waiting", { headers: AUTH })).json()) as {
        waiting: { kind: string }[];
      };
      expect(still.waiting.map((w) => w.kind)).toEqual([kind]);
      expect(stopped).toBe(0);
      expect((await thread(id)).messages.filter((m) => m.role === "user")).toHaveLength(2);
      voice.ws.close();
      release();
      await (await stream).text();
    } finally {
      process.env.ORC_E2E_CHAT_MOCK = "1";
      registerBackend(backend, () => original);
    }
  });

for (const [label, chunks, expected] of [
  ["a reply that repeats the spoken line is not posted again", ["Ma", "rs."], "Mars."],
  ["a repeat in other case and punctuation is dropped", ["MARS"], "Mars."],
  ["a short reworded answer after speaking is dropped", ["It's ", "Mars"], "Mars."],
  ["an invisible reply is dropped", ["​"], "Mars."],
  [
    "code after the spoken line is kept without repeating the line",
    ["Mars.\n\n```sh\nbun", " test\n```"],
    "Mars.\n\n```sh\nbun test\n```",
  ],
  [
    "a multi-line written reply is kept whole",
    ["Results:\n- 12 passed", "\n- 0 failed"],
    "Mars.\n\nResults:\n- 12 passed\n- 0 failed",
  ],
] as const)
  test(label, async () => {
    const id = await chat("Reply with exactly: ok");
    const backend = (
      (await (await app.request(`/api/chat/threads/${id}`, { headers: AUTH })).json()) as {
        backend: string;
      }
    ).backend;
    const original = createBackend(backend);
    const session: AgentSession = {
      id: "voice-dedupe",
      capabilities: original.capabilities,
      getRuntimeSessionId: () => "voice-native",
      send: async () => {},
      respondPermission: () => {},
      respondQuestion: () => {},
      interrupt: async () => {},
      alive: () => true,
      close: async () => {},
      async *events(): AsyncIterable<AgentEvent> {
        await app.request(`/api/chat/threads/${id}/speak`, {
          method: "POST",
          headers: AUTH,
          body: JSON.stringify({ text: "Mars." }),
        });
        for (const chunk of chunks) yield { type: "text", data: chunk };
        yield { type: "result", data: { runtimeSessionId: "voice-native" } };
      },
    };
    registerBackend(backend, () => ({
      ...original,
      preflight: async () => ({ ok: true }),
      startSession: async () => session,
      resumeSession: async () => session,
    }));
    delete process.env.ORC_E2E_CHAT_MOCK;
    try {
      const res = await app.request("/api/chat/stream", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ threadId: id, messages: [{ role: "user", content: "a planet" }] }),
      });
      const streamed = (await res.text())
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)))
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join("");
      const content = (await thread(id)).messages.at(-1)?.content;
      expect(content).toBe(expected);
      expect(streamed).toBe(expected);
    } finally {
      process.env.ORC_E2E_CHAT_MOCK = "1";
      registerBackend(backend, () => original);
    }
  });

for (const failing of ["stt", "tts"] as const)
  test(`a ${failing.toUpperCase()} failure mid-turn reports an error and keeps listening`, async () => {
    const id = await chat("Reply with exactly: ok");
    const voice = await connect(id);
    if (failing === "stt") sttFails = true;
    else ttsFails = true;
    voice.say(speech);
    if (failing === "stt") {
      await voice.next("error");
      expect(voice.messages.find((m) => m.type === "error")?.message).toContain("model not loaded");
    } else {
      await voice.next("transcript");
      const res = await app.request(`/api/chat/threads/${id}/speak`, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ text: "This will fail." }),
      });
      expect(await res.json()).toMatchObject({ spoken: true });
      await voice.next("error");
      expect(voice.messages.find((m) => m.type === "error")?.message).toContain("tts down");
    }
    sttFails = false;
    ttsFails = false;
    voice.messages.length = 0;
    const res = await app.request(`/api/chat/threads/${id}/speak`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ text: "Back again." }),
    });
    expect(await res.json()).toMatchObject({ spoken: true });
    await until(async () => voice.audio.includes("audio:Back again."));
    expect(voice.audio).toContain("audio:Back again.");
    voice.ws.close();
  });
