import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/api/client";
import { HelpPopover } from "@/components/HelpPopover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SPEECH_LANGUAGES } from "@/lib/speech-catalog";
import {
  listVoiceInputs,
  setVoiceInputDevice,
  useVoiceInputDevice,
  type VoiceInput,
} from "@/lib/voice-input";

export function VoiceSettings() {
  const selected = useVoiceInputDevice();
  const [inputs, setInputs] = useState<VoiceInput[] | null>(null);

  const refresh = useCallback(() => {
    listVoiceInputs()
      .then(setInputs)
      .catch(() => setInputs([]));
  }, []);

  useEffect(() => {
    refresh();
    const devices = navigator.mediaDevices;
    if (!devices?.addEventListener) return;
    devices.addEventListener("devicechange", refresh);
    return () => devices.removeEventListener("devicechange", refresh);
  }, [refresh]);

  const disconnected =
    selected !== "" && inputs !== null && !inputs.some((input) => input.deviceId === selected);
  const unnamed = inputs !== null && inputs.length > 0 && inputs.every((input) => !input.label);

  const speech = useQuery({ queryKey: ["speech-settings"], queryFn: api.speech.settings });
  const [language, setLanguage] = useState("");
  const [voice, setVoice] = useState("");
  const [baseline, setBaseline] = useState<{ language: string; voice: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!speech.data || baseline) return;
    setBaseline({ language: speech.data.language, voice: speech.data.voice });
    setLanguage(speech.data.language);
    setVoice(speech.data.voice);
  }, [speech.data, baseline]);

  const current = baseline ?? { language: "", voice: "" };
  const dirty = language !== current.language || voice !== current.voice;
  const voices = speech.data?.voices ?? [];
  const catalog = speech.data !== undefined && speech.data.voice_source !== "none";

  async function saveSpeech() {
    setPending(true);
    setFeedback("");
    setError("");
    try {
      const saved = await api.speech.saveSettings({ language, voice });
      setBaseline({ language: saved.language, voice: saved.voice });
      setLanguage(saved.language);
      setVoice(saved.voice);
      setFeedback("Speech defaults saved on the server.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Speech defaults could not be saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-label="Voice settings" data-testid="voice-settings">
      <div className="mb-2 flex items-center gap-1">
        <h2 className="text-base font-medium">Voice</h2>
        <HelpPopover label="voice settings" testId="settings-voice-help">
          <p>
            The microphone used by composer dictation and voice mode. Saved in this browser, so each
            device picks its own source.
          </p>
          <p className="mt-2">
            System default follows your operating system. Device names appear once the browser has
            microphone permission; the browser needs HTTPS or localhost to reach the microphone.
          </p>
        </HelpPopover>
      </div>
      <p className="mb-6 text-xs text-muted-foreground">
        Saved in this browser. Changes apply immediately.
      </p>
      <div className="grid gap-4 sm:grid-cols-[minmax(160px,1fr)_minmax(0,2fr)]">
        <label htmlFor="settings-voice-input" className="text-sm font-medium">
          Microphone
        </label>
        <div className="space-y-2">
          <select
            id="settings-voice-input"
            data-testid="settings-voice-input"
            className="form-control form-control-single"
            value={selected}
            onChange={(event) => setVoiceInputDevice(event.target.value)}
          >
            <option value="">System default</option>
            {disconnected && <option value={selected}>Disconnected microphone</option>}
            {(inputs ?? []).map((input, index) => (
              <option key={input.deviceId} value={input.deviceId}>
                {input.label || `Microphone ${index + 1}`}
              </option>
            ))}
          </select>
          {disconnected && (
            <p
              role="alert"
              data-testid="settings-voice-disconnected"
              className="text-sm text-error"
            >
              The selected microphone isn't connected. Dictation and voice mode use the system
              default until it returns.
            </p>
          )}
          {unnamed && !disconnected && (
            <p className="text-xs text-muted-foreground" data-testid="settings-voice-unnamed">
              Allow microphone access to see device names.
            </p>
          )}
        </div>
      </div>

      <div className="mt-8 border-t border-border pt-6">
        <div className="mb-2 flex items-center gap-1">
          <h3 className="text-sm font-medium">Speech defaults</h3>
          <HelpPopover label="speech defaults" testId="settings-speech-help">
            <p>
              Saved on the server for every device and channel. The language is sent to the
              transcription provider; auto detect lets the provider decide.
            </p>
            <p className="mt-2">
              The voice is used for spoken replies. OpenAI-compatible servers such as Vocal list
              their voices here; otherwise type a voice id. Voice mode can override the voice in the
              server config.
            </p>
          </HelpPopover>
        </div>
        <p className="mb-6 text-xs text-muted-foreground">
          Saved on the server. Applies to new recordings and replies.
        </p>
        {!speech.data && !speech.error && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading speech defaults…
          </p>
        )}
        {speech.error && (
          <p role="alert" className="text-sm text-error">
            {speech.error instanceof Error ? speech.error.message : "Speech defaults unavailable."}
          </p>
        )}
        {speech.data && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-[minmax(160px,1fr)_minmax(0,2fr)]">
              <label htmlFor="settings-speech-language" className="text-sm font-medium">
                Transcription language
              </label>
              <select
                id="settings-speech-language"
                data-testid="settings-speech-language"
                className="form-control form-control-single"
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
              >
                <option value="">Auto detect</option>
                {SPEECH_LANGUAGES.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {entry.label}
                  </option>
                ))}
                {language && !SPEECH_LANGUAGES.some((entry) => entry.code === language) && (
                  <option value={language}>{language}</option>
                )}
              </select>
            </div>
            <div className="grid gap-4 sm:grid-cols-[minmax(160px,1fr)_minmax(0,2fr)]">
              <label htmlFor="settings-speech-voice" className="text-sm font-medium">
                Reply voice
              </label>
              {catalog ? (
                <select
                  id="settings-speech-voice"
                  data-testid="settings-speech-voice"
                  className="form-control form-control-single"
                  value={voice}
                  onChange={(event) => setVoice(event.target.value)}
                >
                  <option value="">Provider default</option>
                  {voice && !voices.some((entry) => entry.id === voice) && (
                    <option value={voice}>{voice}</option>
                  )}
                  {voices.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                      {entry.language ? ` · ${entry.language}` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  id="settings-speech-voice"
                  data-testid="settings-speech-voice"
                  value={voice}
                  onChange={(event) => setVoice(event.target.value)}
                  placeholder="Provider default when blank"
                />
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                data-testid="settings-speech-save"
                disabled={pending || !dirty}
                onClick={() => void saveSpeech()}
              >
                {pending ? "Saving…" : "Save speech defaults"}
              </Button>
              {feedback && !error && (
                <p
                  role="status"
                  data-testid="settings-speech-feedback"
                  className="text-sm text-muted-foreground"
                >
                  {feedback}
                </p>
              )}
              {error && (
                <p role="alert" data-testid="settings-speech-error" className="text-sm text-error">
                  {error}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
