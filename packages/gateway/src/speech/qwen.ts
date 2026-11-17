import type { OrcConfig } from "@orc/core/config";
import {
  convertAudio,
  mimeForFormat,
  requestSignal,
  type SpeechToText,
  type TextToSpeech,
  transcribable,
} from "./audio.js";

export function qwenSpeechToText(config: OrcConfig): SpeechToText | null {
  const { language, qwen } = config.speech;
  const apiKey = qwen.api_key;
  if (!apiKey) return null;
  const baseUrl = (qwen.base_url ?? "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(
    /\/$/,
    "",
  );
  return {
    async transcribe(input) {
      const { audio, format } = await transcribable(input);
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: qwen.model ?? "qwen3-asr-flash",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "input_audio",
                  input_audio: {
                    data: `data:${mimeForFormat(format)};base64,${Buffer.from(audio).toString("base64")}`,
                  },
                },
              ],
            },
          ],
          ...(language ? { asr_options: { language } } : {}),
        }),
        signal: requestSignal(input.signal),
      });
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };
      if (!response.ok)
        throw new Error(body.error?.message ?? `Speech request failed (${response.status})`);
      return body.choices?.[0]?.message?.content?.trim() ?? "";
    },
  };
}

export function qwenTextToSpeech(config: OrcConfig): TextToSpeech | null {
  const { tts } = config;
  const apiKey = tts.qwen.api_key;
  if (!apiKey) return null;
  return {
    async synthesize(text, signal) {
      const response = await fetch(
        tts.qwen.base_url ??
          "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: tts.qwen.model ?? "qwen3-tts-flash",
            input: { text, voice: tts.voice || "Cherry" },
          }),
          signal: requestSignal(signal),
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
      const audioResponse = await fetch(body.output.audio.url, { signal: requestSignal(signal) });
      const audio = new Uint8Array(await audioResponse.arrayBuffer());
      return { audio: await convertAudio(audio, "wav", "ogg"), format: "ogg" };
    },
  };
}
