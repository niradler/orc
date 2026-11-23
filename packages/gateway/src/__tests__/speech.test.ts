import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type OrcConfig, resetConfig } from "@orc/core/config";
import { openAiTtsVoice } from "../speech/openai.js";
import { listSpeechVoices } from "../speech/voices.js";
import { speechText, speechToText, textToSpeech } from "../speech.js";

const home = mkdtempSync(join(tmpdir(), "orc-speech-"));
const originalOrcHome = process.env.ORC_HOME;

beforeAll(() => {
  process.env.ORC_HOME = home;
  resetConfig();
});

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", name)));
const voiceNote = fixture("voice.ogg");
const spokenWav = fixture("dictation.wav");

type Received = {
  path: string;
  auth: string | null;
  name: string | undefined;
  type: string;
  bytes: Uint8Array;
};
let received: Received[] = [];
let qwenAudioChars = 0;
let ttsRequests: Record<string, unknown>[] = [];
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request): Promise<Response> {
    const { pathname, origin: self } = new URL(request.url);
    const auth = request.headers.get("authorization");
    if (pathname.endsWith("/audio/transcriptions")) {
      const raw = Buffer.from(await request.clone().arrayBuffer()).toString("latin1");
      const [, name, type = ""] =
        /name="file"; filename="([^"]+)"\r\nContent-Type: ([^\r]+)/.exec(raw) ?? [];
      const file = (await request.formData()).get("file") as File;
      received.push({
        path: pathname,
        auth,
        name,
        type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      return new Response("add a retry to the deploy step\n");
    }
    if (pathname.endsWith("/chat/completions")) {
      const body = (await request.json()) as {
        messages: { content: { input_audio: { data: string } }[] }[];
      };
      const audio = body.messages[0]?.content[0]?.input_audio.data ?? "";
      qwenAudioChars = audio.length;
      const [, type = "", data = ""] = /^data:([^;]+);base64,(.*)$/.exec(audio) ?? [];
      received.push({
        path: pathname,
        auth,
        name: undefined,
        type,
        bytes: Buffer.from(data, "base64"),
      });
      return Response.json({
        choices: [{ message: { content: "add a retry to the deploy step" } }],
      });
    }
    if (pathname.endsWith("/audio/speech")) {
      ttsRequests.push((await request.json()) as Record<string, unknown>);
      return new Response(voiceNote, { headers: { "Content-Type": "audio/ogg" } });
    }
    if (pathname.endsWith("/audio/voices")) {
      return Response.json({
        voices: [{ id: "af_heart", name: "Heart", language: "en", gender: "female" }],
        total: 1,
      });
    }
    if (pathname === "/qwen-tts") {
      ttsRequests.push((await request.json()) as Record<string, unknown>);
      return Response.json({ output: { audio: { url: `${self}/qwen-audio.wav` } } });
    }
    if (pathname === "/qwen-audio.wav") return new Response(spokenWav);
    return new Response("gone", { status: 404 });
  },
});
const origin = `http://127.0.0.1:${provider.port}`;

afterAll(() => {
  provider.stop(true);
  if (originalOrcHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = originalOrcHome;
  resetConfig();
  rmSync(home, { recursive: true, force: true });
});

const sttConfig = (name: "openai" | "groq" | "qwen") =>
  loadConfig({
    speech: {
      enabled: true,
      provider: name,
      [name]: { api_key: `${name}-key`, base_url: `${origin}/${name}` },
    },
  } as unknown as Partial<OrcConfig>);

const clips = [
  {
    source: "Telegram voice note",
    file: "voice.ogg",
    format: "ogg",
    type: "audio/ogg",
    ext: "ogg",
  },
  {
    source: "Telegram .oga voice file",
    file: "voice.ogg",
    format: "oga",
    type: "audio/ogg",
    ext: "ogg",
  },
  {
    source: "Chrome recording",
    file: "dictation.webm",
    format: "webm",
    type: "audio/webm",
    ext: "webm",
  },
  { source: "Firefox recording", file: "voice.ogg", format: "ogg", type: "audio/ogg", ext: "ogg" },
  {
    source: "Safari recording",
    file: "dictation.mp4",
    format: "mp4",
    type: "audio/mp4",
    ext: "mp4",
  },
  {
    source: "Telegram m4a audio",
    file: "dictation.mp4",
    format: "x-m4a",
    type: "audio/mp4",
    ext: "m4a",
  },
  { source: "ORC dictation", file: "dictation.wav", format: "wav", type: "audio/wav", ext: "wav" },
];

for (const name of ["openai", "groq", "qwen"] as const)
  for (const clip of clips)
    test(`${name} receives a ${clip.source} byte for byte as ${clip.type}`, async () => {
      received = [];
      const audio = fixture(clip.file);
      const stt = speechToText(sttConfig(name));
      expect(await stt?.transcribe({ audio, format: clip.format })).toBe(
        "add a retry to the deploy step",
      );
      expect(received).toHaveLength(1);
      const [request] = received;
      expect(request?.auth).toBe(`Bearer ${name}-key`);
      expect(request?.type).toBe(clip.type);
      expect(Buffer.from(request?.bytes ?? []).equals(Buffer.from(audio))).toBe(true);
      if (name === "qwen") expect(request?.path).toBe("/qwen/chat/completions");
      else expect(request?.name).toBe(`audio.${clip.ext}`);
    });

test("a recording at Qwen's byte limit still fits its 10 MB encoded audio cap", async () => {
  received = [];
  const stt = speechToText(sttConfig("qwen"));
  const limit = stt?.maxBytes ?? 0;
  expect(speechToText(sttConfig("openai"))?.maxBytes).toBe(25 * 1024 * 1024);
  expect(limit).toBe(7_400_000);
  const wav = new Uint8Array(limit);
  wav.set(spokenWav.subarray(0, 44));
  await stt?.transcribe({ audio: wav, format: "wav" });
  expect(received[0]?.bytes.length).toBe(limit);
  expect(qwenAudioChars).toBeGreaterThan(9_800_000);
  expect(qwenAudioChars).toBeLessThanOrEqual(10_000_000);
});

test("OpenAI speech is requested as an OGG/Opus voice note", async () => {
  ttsRequests = [];
  const tts = textToSpeech(
    loadConfig({
      tts: {
        enabled: true,
        provider: "openai",
        openai: { api_key: "k", base_url: `${origin}/v1` },
      },
    } as unknown as Partial<OrcConfig>),
  );
  const speech = await tts?.synthesize("deploy finished");
  // A custom OpenAI-compatible endpoint picks its own default voice; sending
  // OpenAI's "alloy" would be rejected by servers such as Vocal.
  expect(ttsRequests).toEqual([
    { model: "tts-1", input: "deploy finished", response_format: "opus" },
  ]);
  expect(speech?.format).toBe("ogg");
  expect(new TextDecoder().decode(speech?.audio.slice(0, 4))).toBe("OggS");
});

test("a configured voice reaches a custom endpoint, and OpenAI itself defaults to alloy", async () => {
  ttsRequests = [];
  const tts = textToSpeech(
    loadConfig({
      tts: {
        enabled: true,
        provider: "openai",
        voice: "af_heart",
        openai: { api_key: "k", base_url: `${origin}/v1` },
      },
    } as unknown as Partial<OrcConfig>),
  );
  await tts?.synthesize("deploy finished");
  expect(ttsRequests).toMatchObject([{ voice: "af_heart" }]);
  expect(openAiTtsVoice("", undefined)).toBe("alloy");
  expect(openAiTtsVoice("", `${origin}/v1`)).toBe("");
  expect(openAiTtsVoice("nova", `${origin}/v1`)).toBe("nova");
});

test("the voice catalog comes from the provider, OpenAI's fixed list, or nowhere", async () => {
  const withTts = (tts: Record<string, unknown>) =>
    loadConfig({ tts: { enabled: true, ...tts } } as unknown as Partial<OrcConfig>);
  const live = await listSpeechVoices(
    withTts({ provider: "openai", openai: { api_key: "k", base_url: `${origin}/v1` } }),
  );
  expect(live).toEqual({
    voices: [{ id: "af_heart", name: "Heart", language: "en", gender: "female" }],
    source: "provider",
  });
  const fixed = await listSpeechVoices(withTts({ provider: "openai", openai: { api_key: "k" } }));
  expect(fixed.source).toBe("catalog");
  expect(fixed.voices.map((voice) => voice.id)).toContain("nova");
  const silent = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("gone", { status: 404 }),
  });
  try {
    const missing = await listSpeechVoices(
      withTts({ provider: "openai", openai: { base_url: `http://127.0.0.1:${silent.port}/v1` } }),
    );
    expect(missing).toEqual({ voices: [], source: "none" });
  } finally {
    silent.stop(true);
  }
  expect(await listSpeechVoices(withTts({ provider: "qwen", qwen: { api_key: "k" } }))).toEqual({
    voices: [],
    source: "none",
  });
  expect(
    await listSpeechVoices(
      loadConfig({ tts: { enabled: false } } as unknown as Partial<OrcConfig>),
    ),
  ).toEqual({ voices: [], source: "none" });
});

const qwenTts = (base_url: string) =>
  textToSpeech(
    loadConfig({
      tts: { enabled: true, provider: "qwen", qwen: { api_key: "k", base_url } },
    } as unknown as Partial<OrcConfig>),
  );

test("Qwen speech comes back as the WAV it returns, unconverted", async () => {
  ttsRequests = [];
  const speech = await qwenTts(`${origin}/qwen-tts`)?.synthesize("deploy finished");
  expect(ttsRequests).toMatchObject([
    { model: "qwen3-tts-flash", input: { text: "deploy finished" } },
  ]);
  expect(speech?.format).toBe("wav");
  expect(Buffer.from(speech?.audio ?? []).equals(Buffer.from(spokenWav))).toBe(true);
});

test("a Qwen audio link that fails to download is an error, not an empty voice reply", async () => {
  const failing = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/tts"
        ? Response.json({ output: { audio: { url: `${origin}/expired.wav` } } })
        : new Response("gone", { status: 404 }),
  });
  try {
    await expect(
      qwenTts(`http://127.0.0.1:${failing.port}/tts`)?.synthesize("hi") ?? Promise.resolve(),
    ).rejects.toThrow("Qwen TTS audio download failed (404)");
  } finally {
    failing.stop(true);
  }
});

test("a reply is shortened for speech without code or markdown", () => {
  const reply = [
    "## Result",
    "",
    "The **tests pass** after the fix in [`retry.ts`](src/retry.ts).",
    "",
    "```ts",
    "export const retries = 3;",
    "```",
    "",
    "- Deploy waits for the health check. Logs are kept for seven days!",
    "- Rollback is manual.",
  ].join("\n");
  expect(speechText(reply)).toBe(
    "Result The tests pass after the fix in retry.ts. Deploy waits for the health check. Logs are kept for seven days! Rollback is manual.",
  );
  expect(speechText(reply, 90)).toBe(
    "Result The tests pass after the fix in retry.ts. Deploy waits for the health check.",
  );
  expect(speechText("one two three four", 9)).toBe("one two");
  expect(speechText("```sh\nbun test\n```")).toBe("");
});

test("an unknown speech provider fails when the config loads", () => {
  expect(() =>
    loadConfig({ speech: { provider: "whisperx" } } as unknown as Partial<OrcConfig>),
  ).toThrow(/Invalid orc config[\s\S]*provider/);
});
