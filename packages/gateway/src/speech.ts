import { loadConfig, type OrcConfig } from "@orc/core/config";
import type {
  SpeechToText,
  SpeechToTextFactory,
  TextToSpeech,
  TextToSpeechFactory,
} from "./speech/audio.js";
import { groqSpeechToText } from "./speech/groq.js";
import {
  openaiSpeechToText,
  openaiTextToSpeech,
  vocalSpeechToText,
  vocalTextToSpeech,
} from "./speech/openai.js";
import { qwenSpeechToText, qwenTextToSpeech } from "./speech/qwen.js";

const speechToTextProviders: Record<OrcConfig["speech"]["provider"], SpeechToTextFactory> = {
  openai: openaiSpeechToText,
  groq: groqSpeechToText,
  qwen: qwenSpeechToText,
  vocal: vocalSpeechToText,
};

const textToSpeechProviders: Record<OrcConfig["tts"]["provider"], TextToSpeechFactory> = {
  openai: openaiTextToSpeech,
  qwen: qwenTextToSpeech,
  vocal: vocalTextToSpeech,
};

export type SpeechSite = "dictation" | "voice_mode";

export function speechToText(config = loadConfig(), site?: SpeechSite): SpeechToText | null {
  if (!config.speech.enabled) return null;
  const { provider = config.speech.provider, model } = site ? config.speech[site] : {};
  const speech = model
    ? { ...config.speech, [provider]: { ...config.speech[provider], model } }
    : config.speech;
  return speechToTextProviders[provider]({ ...config, speech });
}

export function textToSpeech(config = loadConfig(), site?: "voice_mode"): TextToSpeech | null {
  if (!config.tts.enabled) return null;
  const {
    provider = config.tts.provider,
    model,
    voice = config.tts.voice,
  } = site ? config.tts[site] : {};
  const tts = {
    ...config.tts,
    voice,
    ...(model ? { [provider]: { ...config.tts[provider], model } } : {}),
  };
  return textToSpeechProviders[provider]({ ...config, tts });
}

export function speechSentences(text: string): string[] {
  return speechText(text)
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
}

const FILLERS = new Set(["uh", "um", "umm", "ah", "eh", "er", "hmm", "mm", "mhm", "huh", "oh"]);

export function isFillerOnly(transcript: string): boolean {
  return transcript
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => FILLERS.has(word));
}

export function speechText(text: string, maxLength = 0): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, " ")
    .replace(/[*_~|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (maxLength <= 0 || plain.length <= maxLength) return plain;
  const head = plain.slice(0, maxLength + 1);
  const sentenceEnd = Math.max(...[". ", "! ", "? "].map((mark) => head.lastIndexOf(mark)));
  if (sentenceEnd > 0) return head.slice(0, sentenceEnd + 1);
  const wordEnd = head.lastIndexOf(" ");
  return (wordEnd > 0 ? head.slice(0, wordEnd) : plain.slice(0, maxLength)).trim();
}
