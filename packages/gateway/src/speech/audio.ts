import type { OrcConfig } from "@orc/core/config";

export type SpeechAudio = { audio: Uint8Array; format: string };
export type SynthesizedSpeech = { audio: Uint8Array; format: "ogg" | "wav" };

export interface SpeechToText {
  maxBytes: number;
  transcribe(input: SpeechAudio & { signal?: AbortSignal }): Promise<string>;
}

export interface TextToSpeech {
  synthesize(text: string, signal?: AbortSignal): Promise<SynthesizedSpeech>;
}

export type SpeechToTextFactory = (config: OrcConfig) => SpeechToText | null;
export type TextToSpeechFactory = (config: OrcConfig) => TextToSpeech | null;

export function formatToExt(format: string): string {
  const normalized = format.toLowerCase().replace(/^x-/, "");
  if (normalized === "oga" || normalized === "opus") return "ogg";
  if (normalized === "mpeg" || normalized === "mpga") return "mp3";
  return normalized;
}

export function mimeForFormat(format: string): string {
  const ext = formatToExt(format);
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "m4a") return "audio/mp4";
  return `audio/${ext}`;
}

export function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(60_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
