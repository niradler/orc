import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resetConfig } from "@orc/core/config";
import { setupTestApp, teardownTestApp } from "./helpers";

const auth = { Authorization: "Bearer test-secret" };
const clip = readFileSync(join(import.meta.dir, "fixtures", "dictation.webm"));
let app: ReturnType<typeof setupTestApp>;
let received: { auth: string | null; model: unknown; name: string; size: number }[] = [];
let reply = { body: "add a retry to the deploy step", status: 200 };
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const form = await request.formData();
    const file = form.get("file") as File;
    received.push({
      auth: request.headers.get("authorization"),
      model: form.get("model"),
      name: file.name,
      size: file.size,
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
  expect(received).toEqual([
    {
      auth: "Bearer sk-test-secret-key",
      model: "whisper-1",
      name: "audio.webm",
      size: clip.length,
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
