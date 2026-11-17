import type { OrcConfig } from "@orc/core/config";
import {
  formatToExt,
  mimeForFormat,
  requestSignal,
  type SpeechToText,
  type TextToSpeech,
  transcribable,
} from "./audio.js";

export function whisperSpeechToText(
  settings: OrcConfig["speech"]["openai"],
  language: string,
  defaults: { baseUrl: string; model: string },
): SpeechToText | null {
  const apiKey = settings.api_key;
  if (!apiKey) return null;
  const baseUrl = (settings.base_url ?? defaults.baseUrl).replace(/\/$/, "");
  return {
    async transcribe(input) {
      const { audio, format } = await transcribable(input);
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
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: requestSignal(input.signal),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(text || `Speech request failed (${response.status})`);
      return text.trim();
    },
  };
}

export const openaiSpeechToText = (config: OrcConfig) =>
  whisperSpeechToText(config.speech.openai, config.speech.language, {
    baseUrl: "https://api.openai.com/v1",
    model: "whisper-1",
  });

export function openaiTextToSpeech(config: OrcConfig): TextToSpeech | null {
  const { tts } = config;
  const apiKey = tts.openai.api_key ?? config.speech.openai.api_key;
  if (!apiKey) return null;
  const baseUrl = (tts.openai.base_url ?? "https://api.openai.com/v1").replace(/\/$/, "");
  return {
    async synthesize(text, signal) {
      const response = await fetch(`${baseUrl}/audio/speech`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: tts.openai.model ?? "tts-1",
          input: text,
          voice: tts.voice || "alloy",
        }),
        signal: requestSignal(signal),
      });
      if (!response.ok) throw new Error(await response.text());
      return { audio: new Uint8Array(await response.arrayBuffer()), format: "mp3" };
    },
  };
}
