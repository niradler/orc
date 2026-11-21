import { useCallback, useEffect, useState } from "react";
import { HelpPopover } from "@/components/HelpPopover";
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
    </section>
  );
}
