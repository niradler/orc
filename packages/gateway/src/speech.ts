import { loadConfig, type OrcConfig } from "@orc/core/config";
import type {
  SpeechToText,
  SpeechToTextFactory,
  TextToSpeech,
  TextToSpeechFactory,
} from "./speech/audio.js";
import { groqSpeechToText } from "./speech/groq.js";
import { openaiSpeechToText, openaiTextToSpeech } from "./speech/openai.js";
import { qwenSpeechToText, qwenTextToSpeech } from "./speech/qwen.js";

const speechToTextProviders: Record<OrcConfig["speech"]["provider"], SpeechToTextFactory> = {
  openai: openaiSpeechToText,
  groq: groqSpeechToText,
  qwen: qwenSpeechToText,
};

const textToSpeechProviders: Record<OrcConfig["tts"]["provider"], TextToSpeechFactory> = {
  openai: openaiTextToSpeech,
  qwen: qwenTextToSpeech,
};

export function speechToText(config = loadConfig()): SpeechToText | null {
  return config.speech.enabled ? speechToTextProviders[config.speech.provider](config) : null;
}

export function textToSpeech(config = loadConfig()): TextToSpeech | null {
  return config.tts.enabled ? textToSpeechProviders[config.tts.provider](config) : null;
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
