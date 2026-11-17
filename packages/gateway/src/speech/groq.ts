import type { OrcConfig } from "@orc/core/config";
import { whisperSpeechToText } from "./openai.js";

export const groqSpeechToText = (config: OrcConfig) =>
  whisperSpeechToText(config.speech.groq, config.speech.language, {
    baseUrl: "https://api.groq.com/openai/v1",
    model: "whisper-large-v3-turbo",
  });
