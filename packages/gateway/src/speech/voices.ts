import type { OrcConfig } from "@orc/core/config";

export type SpeechVoice = { id: string; name: string; language?: string; gender?: string };
export type SpeechVoiceCatalog = {
  voices: SpeechVoice[];
  source: "provider" | "catalog" | "none";
};

const OPENAI_TTS_VOICES: Record<string, string[]> = {
  "tts-1": ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
  "tts-1-hd": ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
  "gpt-4o-mini-tts": [
    "alloy",
    "ash",
    "ballad",
    "coral",
    "echo",
    "fable",
    "onyx",
    "nova",
    "sage",
    "shimmer",
    "verse",
  ],
};

/** OpenAI has no list-voices endpoint; its catalog is fixed per model. */
export function openAiVoiceCatalog(model: string): SpeechVoice[] {
  return (OPENAI_TTS_VOICES[model] ?? OPENAI_TTS_VOICES["tts-1"] ?? []).map((id) => ({
    id,
    name: id,
  }));
}

/** Voices for the configured TTS provider: a live catalog when the server exposes
 *  one (Vocal's /audio/voices), OpenAI's fixed catalog, or none for free-text ids. */
export async function listSpeechVoices(config: OrcConfig): Promise<SpeechVoiceCatalog> {
  if (!config.tts.enabled || config.tts.provider !== "openai")
    return { voices: [], source: "none" };
  const settings = config.tts.openai;
  const model = settings.model ?? "tts-1";
  if (!settings.base_url) return { voices: openAiVoiceCatalog(model), source: "catalog" };
  const baseUrl = settings.base_url.replace(/\/$/, "");
  try {
    const response = await fetch(`${baseUrl}/audio/voices?model=${encodeURIComponent(model)}`, {
      headers: settings.api_key ? { Authorization: `Bearer ${settings.api_key}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { voices: [], source: "none" };
    const body = (await response.json()) as {
      voices?: Array<{ id?: unknown; name?: unknown; language?: unknown; gender?: unknown }>;
    };
    const voices = (body.voices ?? [])
      .filter(
        (voice): voice is { id: string; name?: unknown; language?: unknown; gender?: unknown } =>
          typeof voice?.id === "string" && voice.id !== "",
      )
      .map((voice) => ({
        id: voice.id,
        name: typeof voice.name === "string" && voice.name ? voice.name : voice.id,
        ...(typeof voice.language === "string" && voice.language
          ? { language: voice.language }
          : {}),
        ...(typeof voice.gender === "string" && voice.gender ? { gender: voice.gender } : {}),
      }));
    return { voices, source: "provider" };
  } catch {
    return { voices: [], source: "none" };
  }
}
