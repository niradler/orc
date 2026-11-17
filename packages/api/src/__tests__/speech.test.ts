import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resetConfig } from "@orc/core/config";
import { setupTestApp, teardownTestApp } from "./helpers";

const auth = { Authorization: "Bearer test-secret" };
const clip = readFileSync(join(import.meta.dir, "fixtures", "dictation.webm"));
const wav = readFileSync(
  join(import.meta.dir, "../../../gateway/src/__tests__/fixtures/dictation.wav"),
);
let app: ReturnType<typeof setupTestApp>;
let received: {
  auth: string | null;
  model: unknown;
  name: string;
  size: number;
  type: string | undefined;
  bytes: Buffer;
}[] = [];
let reply = { body: "add a retry to the deploy step", status: 200 };
const qwenRequests: Record<string, unknown>[] = [];
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/chat/completions")) {
      const body = (await request.json()) as Record<string, unknown>;
      qwenRequests.push({ auth: request.headers.get("authorization"), ...body });
      return Response.json({ choices: [{ message: { content: " qwen heard it " } }] });
    }
    const raw = Buffer.from(await request.clone().arrayBuffer()).toString("latin1");
    const form = await request.formData();
    const file = form.get("file") as File;
    received.push({
      auth: request.headers.get("authorization"),
      model: form.get("model"),
      name: file.name,
      size: file.size,
      type: /filename="[^"]+"\r\nContent-Type: ([^\r]+)/.exec(raw)?.[1],
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    return new Response(reply.body, { status: reply.status });
  },
});

function configure(speech: Record<string, unknown>) {
  writeFileSync(join(process.env.ORC_HOME ?? "", "config.json"), JSON.stringify({ speech }));
  resetConfig();
}

function transcribe(body: Blob) {
  const form = new FormData();
  form.set("audio", body, "dictation.webm");
  return app.request("/api/speech/transcribe", { method: "POST", headers: auth, body: form });
}

beforeAll(() => {
  app = setupTestApp();
});
afterAll(() => {
  provider.stop(true);
  teardownTestApp();
});

test("speech stays unavailable until a provider key is configured", async () => {
  const status = await app.request("/api/speech/status", { headers: auth });
  expect(await status.json()).toEqual({ available: false });
  configure({ enabled: true, provider: "openai" });
  expect(await (await app.request("/api/speech/status", { headers: auth })).json()).toEqual({
    available: false,
  });
  const res = await transcribe(new Blob([clip], { type: "audio/webm;codecs=opus" }));
  expect(res.status).toBe(409);
  expect(((await res.json()) as { code: string }).code).toBe("SPEECH_UNAVAILABLE");
  expect(received).toHaveLength(0);
});

test("a recorded clip goes to the configured provider and the key never comes back", async () => {
  configure({
    enabled: true,
    provider: "openai",
    openai: { api_key: "sk-test-secret-key", base_url: `http://127.0.0.1:${provider.port}/v1` },
  });
  const status = await app.request("/api/speech/status", { headers: auth });
  expect(await status.text()).toBe('{"available":true}');
  received = [];
  const res = await transcribe(new Blob([clip], { type: "audio/webm;codecs=opus" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ text: "add a retry to the deploy step" });
  expect(received).toMatchObject([
    {
      auth: "Bearer sk-test-secret-key",
      model: "whisper-1",
      name: "audio.webm",
      size: clip.length,
      type: "audio/webm",
    },
  ]);

  reply = { body: "Incorrect API key provided: sk-test-secret-key", status: 401 };
  const failed = await transcribe(new Blob([clip], { type: "audio/webm" }));
  expect(failed.status).toBe(502);
  const body = await failed.text();
  expect(body).toContain("Incorrect API key provided: [redacted]");
  expect(body).not.toContain("sk-test");
});

test("an empty recording is rejected before reaching the provider", async () => {
  received = [];
  const res = await transcribe(new Blob([], { type: "audio/webm" }));
  expect(res.status).toBe(400);
  expect(received).toHaveLength(0);
});

test("an unknown audio type is sent to the provider as webm", async () => {
  reply = { body: "ok", status: 200 };
  received = [];
  const res = await transcribe(new Blob([clip], { type: "audio/x\\..\\..\\evil" }));
  expect(res.status).toBe(200);
  expect(received.map((r) => r.name)).toEqual(["audio.webm"]);
});

test("a WAV dictation reaches the provider unchanged as audio/wav", async () => {
  reply = { body: "add a retry to the deploy step", status: 200 };
  received = [];
  const form = new FormData();
  form.set("audio", new Blob([wav], { type: "audio/wav" }), "dictation.wav");
  const res = await app.request("/api/speech/transcribe", {
    method: "POST",
    headers: auth,
    body: form,
  });
  expect(await res.json()).toEqual({ text: "add a retry to the deploy step" });
  expect(received.map(({ name, type }) => ({ name, type }))).toEqual([
    { name: "audio.wav", type: "audio/wav" },
  ]);
  expect(received[0]?.bytes.equals(wav)).toBe(true);
});

test("an oversized recording is rejected with 413 before reaching the provider", async () => {
  received = [];
  const res = await transcribe(new Blob([new Uint8Array(25 * 1024 * 1024 + 128 * 1024)]));
  expect(res.status).toBe(413);
  expect(((await res.json()) as { code: string }).code).toBe("TOO_LARGE");
  expect(received).toHaveLength(0);
});

test("switching speech.provider changes the backend while the route stays the same", async () => {
  const base_url = `http://127.0.0.1:${provider.port}/v1`;
  reply = { body: "groq heard it", status: 200 };
  received = [];
  configure({
    enabled: true,
    provider: "groq",
    language: "en",
    groq: { api_key: "gsk_x", base_url },
  });
  const groq = await transcribe(new Blob([clip], { type: "audio/webm" }));
  expect(await groq.json()).toEqual({ text: "groq heard it" });
  expect(received.map((r) => [r.auth, r.model])).toEqual([
    ["Bearer gsk_x", "whisper-large-v3-turbo"],
  ]);

  configure({
    enabled: true,
    provider: "qwen",
    language: "en",
    qwen: { api_key: "q-key", base_url },
  });
  const qwen = await transcribe(new Blob([clip], { type: "audio/webm" }));
  expect(await qwen.json()).toEqual({ text: "qwen heard it" });
  expect(qwenRequests).toMatchObject([
    { auth: "Bearer q-key", model: "qwen3-asr-flash", asr_options: { language: "en" } },
  ]);
  expect(received).toHaveLength(1);
});
