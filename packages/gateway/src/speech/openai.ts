import type { OrcConfig } from "@orc/core/config";
import {
  formatToExt,
  mimeForFormat,
  requestSignal,
  type SpeechToText,
  type TextToSpeech,
} from "./audio.js";

type ProviderSettings = OrcConfig["speech"]["openai"];
type Defaults = { baseUrl: string; model: string };

export function whisperSpeechToText(
  settings: ProviderSettings,
  language: string,
  defaults: Defaults,
): SpeechToText | null {
  const apiKey = settings.api_key;
  if (!apiKey && !settings.base_url) return null;
  const baseUrl = (settings.base_url ?? defaults.baseUrl).replace(/\/$/, "");
  return {
    maxBytes: 25 * 1024 * 1024,
    async transcribe(input) {
      const { audio, format } = input;
      const form = new FormData();
      form.append("model", settings.model ?? defaults.model);
      form.append("response_format", "text");
      if (language) form.append("language", language);
      form.append(
        "file",
        new File([audio], `audio.${formatToExt(format)}`, { type: mimeForFormat(format) }),
      );
      const response = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        body: form,
        signal: requestSignal(input.signal),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(text || `Speech request failed (${response.status})`);
      if (!response.headers.get("content-type")?.includes("json")) return text.trim();
      return String((JSON.parse(text) as { text?: unknown }).text ?? "").trim();
    },
  };
}

function speechEndpoint(
  settings: ProviderSettings,
  voice: string | undefined,
  defaults: Defaults & { format: "opus" | "wav" },
): TextToSpeech | null {
  const apiKey = settings.api_key;
  if (!apiKey && !settings.base_url) return null;
  const baseUrl = (settings.base_url ?? defaults.baseUrl).replace(/\/$/, "");
  return {
    async synthesize(text, signal) {
      const response = await fetch(`${baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: settings.model ?? defaults.model,
          input: text,
          ...(voice ? { voice } : {}),
          response_format: defaults.format,
        }),
        signal: requestSignal(signal),
      });
      if (!response.ok) throw new Error(await response.text());
      return {
        audio: new Uint8Array(await response.arrayBuffer()),
        format: defaults.format === "opus" ? "ogg" : "wav",
      };
    },
  };
}

export const openaiSpeechToText = (config: OrcConfig) =>
  whisperSpeechToText(config.speech.openai, config.speech.language, {
    baseUrl: "https://api.openai.com/v1",
    model: "whisper-1",
  });

export const openaiTextToSpeech = (config: OrcConfig) =>
  speechEndpoint(
    { ...config.tts.openai, api_key: config.tts.openai.api_key ?? config.speech.openai.api_key },
    config.tts.voice || "alloy",
    { baseUrl: "https://api.openai.com/v1", model: "tts-1", format: "opus" },
  );
