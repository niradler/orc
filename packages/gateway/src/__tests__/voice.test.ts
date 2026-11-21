import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type OrcConfig, resetConfig } from "@orc/core/config";
import { createTurnDetector, pcm16Wav, type TurnEvent } from "../speech/vad.js";
import { isFillerOnly, speechSentences, speechToText, textToSpeech } from "../speech.js";

const home = mkdtempSync(join(tmpdir(), "orc-voice-"));
process.env.ORC_HOME = home;
resetConfig();

const clip = readFileSync(join(import.meta.dir, "fixtures", "dictation.wav"));
const speech = new Int16Array(
  clip.buffer.slice(clip.byteOffset + 44, clip.byteOffset + clip.length),
);

const requests: { path: string; auth: string | null; body: Record<string, unknown> }[] = [];
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const auth = request.headers.get("authorization");
    if (pathname.endsWith("/audio/transcriptions")) {
      const form = await request.formData();
      requests.push({ path: pathname, auth, body: { model: form.get("model") } });
      return pathname.startsWith("/local")
        ? Response.json({ text: " local heard it ", language: "en" })
        : new Response("heard it\n");
    }
    requests.push({
      path: pathname,
      auth,
      body: (await request.json()) as Record<string, unknown>,
    });
    return new Response(clip, { headers: { "Content-Type": "audio/wav" } });
  },
});
const origin = `http://127.0.0.1:${provider.port}`;

afterAll(() => {
  provider.stop(true);
  rmSync(home, { recursive: true, force: true });
});

const config = (value: Record<string, unknown>) =>
  loadConfig(value as unknown as Partial<OrcConfig>);

test("dictation and voice mode each use their own STT provider and model", async () => {
  const settings = config({
    speech: {
      enabled: true,
      provider: "openai",
      openai: { api_key: "sk-test", base_url: `${origin}/openai` },
      groq: { api_key: "gsk-test", base_url: `${origin}/groq` },
      dictation: { provider: "groq", model: "whisper-large-v3" },
      voice_mode: { model: "gpt-4o-mini-transcribe" },
    },
  });
  requests.length = 0;
  const audio = { audio: new Uint8Array(clip), format: "wav" };
  expect(await speechToText(settings)?.transcribe(audio)).toBe("heard it");
  expect(await speechToText(settings, "dictation")?.transcribe(audio)).toBe("heard it");
  expect(await speechToText(settings, "voice_mode")?.transcribe(audio)).toBe("heard it");
  const local = config({
    speech: { enabled: true, provider: "openai", openai: { base_url: `${origin}/local` } },
  });
  expect(await speechToText(local)?.transcribe(audio)).toBe("local heard it");
  expect(requests).toEqual([
    { path: "/openai/audio/transcriptions", auth: "Bearer sk-test", body: { model: "whisper-1" } },
    {
      path: "/groq/audio/transcriptions",
      auth: "Bearer gsk-test",
      body: { model: "whisper-large-v3" },
    },
    {
      path: "/openai/audio/transcriptions",
      auth: "Bearer sk-test",
      body: { model: "gpt-4o-mini-transcribe" },
    },
    { path: "/local/audio/transcriptions", auth: null, body: { model: "whisper-1" } },
  ]);
});

test("a config written before use sites existed resolves every site to the shared provider", () => {
  const settings = config({
    speech: { enabled: true, provider: "openai", openai: { api_key: "sk-test" } },
    tts: { enabled: true, provider: "openai", voice: "nova" },
  });
  expect(settings.speech.voice_mode).toEqual({ silence_ms: 800, threshold_db: -45 });
  expect(speechToText(settings, "dictation")).not.toBeNull();
  expect(speechToText(settings, "voice_mode")).not.toBeNull();
  expect(textToSpeech(settings, "voice_mode")).not.toBeNull();
  expect(speechToText(config({ speech: { enabled: true, provider: "groq" } }), "voice_mode")).toBe(
    null,
  );
});

test("an OpenAI-compatible base_url needs no key and voice mode can choose its own TTS model and voice", async () => {
  const settings = config({
    tts: {
      enabled: true,
      provider: "openai",
      openai: { api_key: "sk-test", base_url: `${origin}/openai` },
      voice_mode: { model: "hexgrad/Kokoro-82M", voice: "af_heart" },
    },
  });
  requests.length = 0;
  const shared = await textToSpeech(settings)?.synthesize("Deploy finished.");
  const voice = await textToSpeech(settings, "voice_mode")?.synthesize("Deploy finished.");
  const keyless = await textToSpeech(
    config({ tts: { enabled: true, provider: "openai", openai: { base_url: `${origin}/local` } } }),
  )?.synthesize("Hi.");
  expect([shared?.format, voice?.format, keyless?.format]).toEqual(["ogg", "ogg", "ogg"]);
  expect(requests).toEqual([
    {
      path: "/openai/audio/speech",
      auth: "Bearer sk-test",
      body: { model: "tts-1", input: "Deploy finished.", response_format: "opus" },
    },
    {
      path: "/openai/audio/speech",
      auth: "Bearer sk-test",
      body: {
        model: "hexgrad/Kokoro-82M",
        input: "Deploy finished.",
        voice: "af_heart",
        response_format: "opus",
      },
    },
    {
      path: "/local/audio/speech",
      auth: null,
      body: { model: "tts-1", input: "Hi.", response_format: "opus" },
    },
  ]);
});

test("spoken text is split into sentences with code and markdown removed", () => {
  expect(
    speechSentences(
      "Running the **tests** now. They take 2 min! Done? v1.2 is out\n```ts\nrun()\n```",
    ),
  ).toEqual(["Running the tests now.", "They take 2 min!", "Done?", "v1.2 is out"]);
  expect(speechSentences("```sh\nbun test\n```")).toEqual([]);
});

test("filler-only transcripts are ignored, real requests are not", () => {
  expect(["", "Um.", "uh, hmm...", "Mhm"].map(isFillerOnly)).toEqual([true, true, true, true]);
  expect(["Um, run the tests.", "OK", "stop"].map(isFillerOnly)).toEqual([false, false, false]);
});

function detect(samples: Int16Array, chunk: number) {
  const detector = createTurnDetector({ silenceMs: 800, thresholdDb: -45 });
  const events: TurnEvent[] = [];
  for (let offset = 0; offset < samples.length; offset += chunk)
    events.push(...detector.push(samples.slice(offset, offset + chunk)));
  return [...events, ...detector.flush()];
}

test("a real spoken clip between silences is one turn, in any chunking", () => {
  const audio = new Int16Array(16_000 + speech.length + 16_000);
  audio.set(speech, 16_000);
  for (const chunk of [320, 1000, 4097]) {
    const events = detect(audio, chunk);
    expect(events.map((event) => event.type)).toEqual(["start", "end"]);
    const end = events[1] as Extract<TurnEvent, { type: "end" }>;
    const seconds = (end.audio?.length ?? 0) / 16_000;
    expect(seconds).toBeGreaterThan(speech.length / 16_000);
    expect(seconds).toBeLessThan(speech.length / 16_000 + 1.2);
  }
});

test("silence never starts a turn and a short click ends one without audio", () => {
  expect(detect(new Int16Array(48_000), 320)).toEqual([]);
  const click = new Int16Array(16_000 + 1600 + 16_000);
  click.fill(8000, 16_000, 16_000 + 1600);
  expect(detect(click, 320)).toEqual([{ type: "start" }, { type: "end", audio: null }]);
});

test("a turn audio becomes a 16 kHz mono 16-bit WAV with the samples intact", () => {
  const wav = pcm16Wav(speech);
  const view = new DataView(wav.buffer);
  expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
  expect([view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true)]).toEqual([
    1, 16_000, 16,
  ]);
  expect(Buffer.from(wav.slice(44)).equals(Buffer.from(clip.subarray(44)))).toBe(true);
});
