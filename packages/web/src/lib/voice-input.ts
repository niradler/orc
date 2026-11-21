import { useSyncExternalStore } from "react";

export const VOICE_INPUT_DEVICE_KEY = "orc_voice_input_device";
const DEVICE_EVENT = "orc-voice-input-device-change";

/** The saved microphone deviceId; "" means the system default. */
export function getVoiceInputDevice(): string {
  try {
    return localStorage.getItem(VOICE_INPUT_DEVICE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setVoiceInputDevice(deviceId: string): void {
  try {
    if (deviceId) localStorage.setItem(VOICE_INPUT_DEVICE_KEY, deviceId);
    else localStorage.removeItem(VOICE_INPUT_DEVICE_KEY);
  } catch {}
  window.dispatchEvent(new Event(DEVICE_EVENT));
}

function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === VOICE_INPUT_DEVICE_KEY || event.key === null) listener();
  };
  window.addEventListener(DEVICE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(DEVICE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useVoiceInputDevice(): string {
  return useSyncExternalStore(subscribe, getVoiceInputDevice, () => "");
}

export type VoiceInput = { deviceId: string; label: string };

/** Connected microphones. Labels stay empty until the browser has mic permission;
 *  the "default" pseudo-device is skipped because System default already covers it. */
export async function listVoiceInputs(): Promise<VoiceInput[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter(
      (device) =>
        device.kind === "audioinput" && device.deviceId !== "" && device.deviceId !== "default",
    )
    .map((device) => ({ deviceId: device.deviceId, label: device.label }));
}

export function voiceInputConstraints(deviceId: string): MediaTrackConstraints {
  const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return audio;
}

/** Opens the chosen microphone. A selection that is no longer connected falls back
 *  to the system default instead of failing the recording. */
export async function openMicrophone(deviceId: string): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone needs HTTPS.");
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: voiceInputConstraints(deviceId) });
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    if (!deviceId || (name !== "OverconstrainedError" && name !== "NotFoundError")) throw err;
    return await navigator.mediaDevices.getUserMedia({ audio: voiceInputConstraints("") });
  }
}
