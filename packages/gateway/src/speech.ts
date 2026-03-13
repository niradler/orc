import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@orc/core/config";

function ffmpegPath(): string | null {
  const path = Bun.which("ffmpeg");
  return path ?? null;
}

function formatToExt(format: string): string {
  const normalized = format.toLowerCase();
  if (normalized === "oga" || normalized === "opus") return "ogg";
  if (normalized === "mpeg" || normalized === "mpga") return "mp3";
  return normalized;
}

function mimeForFormat(format: string): string {
  const normalized = format.toLowerCase();
  if (normalized === "wav") return "audio/wav";
  if (normalized === "ogg" || normalized === "opus") return "audio/ogg";
  if (normalized === "mp4" || normalized === "m4a") return "audio/mp4";
  return "audio/mpeg";
}

export function canConvertAudio(): boolean {
  return ffmpegPath() !== null;
}

export function convertAudio(
  input: Uint8Array,
  srcFormat: string,
  targetFormat: "mp3" | "ogg",
): Uint8Array {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) throw new Error("ffmpeg is required for voice support.");
  const dir = mkdtempSync(join(tmpdir(), "orc-gateway-"));
  const sourcePath = join(dir, `input.${formatToExt(srcFormat)}`);
  const targetPath = join(dir, `output.${targetFormat}`);
  writeFileSync(sourcePath, input);
  const args = ["-y", "-i", sourcePath];
  if (targetFormat === "mp3") args.push("-ac", "1", "-ar", "16000");
  if (targetFormat === "ogg") args.push("-c:a", "libopus");
  args.push(targetPath);
  const result = Bun.spawnSync({ cmd: [ffmpeg, ...args], stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) {
    const message = new TextDecoder().decode(result.stderr);
    rmSync(dir, { recursive: true, force: true });
    throw new Error(message || "ffmpeg conversion failed");
  }
  const output = readFileSync(targetPath);
  rmSync(dir, { recursive: true, force: true });
  return new Uint8Array(output);
}

function needsConversion(format: string): boolean {
  return !["mp3", "wav", "webm", "m4a", "mp4"].includes(format.toLowerCase());
}

export async function transcribeAudio(input: {
  audio: Uint8Array;
  format: string;
}): Promise<string> {
  const config = loadConfig();
  if (!config.speech.enabled) throw new Error("Speech support is not enabled.");
  let data = input.audio;
  let format = input.format;
  if (needsConversion(format)) {
    data = convertAudio(data, format, "mp3");
    format = "mp3";
  }

  if (config.speech.provider === "qwen") {
    const apiKey = config.speech.qwen.api_key;
    if (!apiKey) throw new Error("Qwen speech API key is not configured.");
    const baseUrl =
      config.speech.qwen.base_url ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";
    const payload = {
      model: config.speech.qwen.model ?? "qwen3-asr-flash",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: {
                data: `data:${mimeForFormat(format)};base64,${Buffer.from(data).toString("base64")}`,
              },
            },
          ],
        },
      ],
    };
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (!response.ok)
      throw new Error(body.error?.message ?? `Speech request failed (${response.status})`);
    return body.choices?.[0]?.message?.content?.trim() ?? "";
  }

  const provider = config.speech.provider === "groq" ? config.speech.groq : config.speech.openai;
  if (!provider.api_key) throw new Error("Speech API key is not configured.");
  const baseUrl =
    provider.base_url ??
    (config.speech.provider === "groq"
      ? "https://api.groq.com/openai/v1"
      : "https://api.openai.com/v1");
  const form = new FormData();
  form.append(
    "model",
    provider.model ?? (config.speech.provider === "groq" ? "whisper-large-v3-turbo" : "whisper-1"),
  );
  form.append("response_format", "text");
  if (config.speech.language) form.append("language", config.speech.language);
  form.append(
    "file",
    new File([data], `audio.${formatToExt(format)}`, { type: mimeForFormat(format) }),
  );

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${provider.api_key}` },
    body: form,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `Speech request failed (${response.status})`);
  return text.trim();
}

export async function synthesizeSpeech(
  text: string,
): Promise<{ audio: Uint8Array; format: "mp3" | "ogg" }> {
  const config = loadConfig();
  if (!config.tts.enabled) throw new Error("TTS is not enabled.");
  if (config.tts.max_text_len > 0 && text.length > config.tts.max_text_len) {
    throw new Error("Reply is too long for TTS.");
  }

  if (config.tts.provider === "qwen") {
    const apiKey = config.tts.qwen.api_key;
    if (!apiKey) throw new Error("Qwen TTS API key is not configured.");
    const response = await fetch(
      config.tts.qwen.base_url ??
        "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.tts.qwen.model ?? "qwen3-tts-flash",
          input: { text, voice: config.tts.voice || "Cherry" },
        }),
      },
    );
    const body = (await response.json()) as {
      output?: { audio?: { url?: string } };
      code?: string;
      message?: string;
    };
    if (!response.ok || body.code)
      throw new Error(body.message ?? `TTS request failed (${response.status})`);
    if (!body.output?.audio?.url) throw new Error("Qwen TTS did not return audio.");
    const audioResponse = await fetch(body.output.audio.url);
    const audio = new Uint8Array(await audioResponse.arrayBuffer());
    return { audio: convertAudio(audio, "wav", "ogg"), format: "ogg" };
  }

  const apiKey = config.tts.openai.api_key ?? config.speech.openai.api_key;
  if (!apiKey) throw new Error("OpenAI TTS API key is not configured.");
  const baseUrl = config.tts.openai.base_url ?? "https://api.openai.com/v1";
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.tts.openai.model ?? "tts-1",
      input: text,
      voice: config.tts.voice || "alloy",
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  const audio = new Uint8Array(await response.arrayBuffer());
  return { audio, format: "mp3" };
}
