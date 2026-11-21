import { beforeEach, describe, expect, test } from "bun:test";
import {
  getVoiceInputDevice,
  listVoiceInputs,
  openMicrophone,
  setVoiceInputDevice,
  VOICE_INPUT_DEVICE_KEY,
  voiceInputConstraints,
} from "../../src/lib/voice-input";

const store = new Map<string, string>();
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: (index: number) => [...store.keys()][index] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

Object.assign(globalThis, {
  window: {
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Window,
  localStorage: storage,
});

function mockMediaDevices(overrides: Partial<MediaDevices>): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: overrides },
  });
}

const stream = { getTracks: () => [] } as unknown as MediaStream;

beforeEach(() => store.clear());

describe("voice input selection", () => {
  test("defaults to the system default and round-trips a saved device", () => {
    expect(getVoiceInputDevice()).toBe("");
    setVoiceInputDevice("mic-2");
    expect(getVoiceInputDevice()).toBe("mic-2");
    expect(store.get(VOICE_INPUT_DEVICE_KEY)).toBe("mic-2");
    setVoiceInputDevice("");
    expect(getVoiceInputDevice()).toBe("");
    expect(store.has(VOICE_INPUT_DEVICE_KEY)).toBe(false);
  });

  test("constraints pin the chosen device and otherwise stay unconstrained", () => {
    expect(voiceInputConstraints("")).toEqual({ echoCancellation: true, noiseSuppression: true });
    expect(voiceInputConstraints("mic-2")).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      deviceId: { exact: "mic-2" },
    });
  });

  test("lists microphones only, skipping the default alias and unnamed ids", async () => {
    mockMediaDevices({
      enumerateDevices: async () =>
        [
          { kind: "audioinput", deviceId: "default", label: "Default - Mic A" },
          { kind: "audioinput", deviceId: "mic-1", label: "Mic A" },
          { kind: "audioinput", deviceId: "mic-2", label: "" },
          { kind: "audioinput", deviceId: "", label: "" },
          { kind: "videoinput", deviceId: "cam-1", label: "Camera" },
          { kind: "audiooutput", deviceId: "spk-1", label: "Speakers" },
        ] as MediaDeviceInfo[],
    });
    expect(await listVoiceInputs()).toEqual([
      { deviceId: "mic-1", label: "Mic A" },
      { deviceId: "mic-2", label: "" },
    ]);
  });

  test("no media devices means no selectable inputs", async () => {
    mockMediaDevices({});
    expect(await listVoiceInputs()).toEqual([]);
  });

  test("opens the chosen microphone with an exact device constraint", async () => {
    const calls: MediaStreamConstraints[] = [];
    mockMediaDevices({
      getUserMedia: async (constraints) => {
        calls.push(constraints ?? {});
        return stream;
      },
    });
    expect(await openMicrophone("mic-2")).toBe(stream);
    expect(calls).toEqual([{ audio: voiceInputConstraints("mic-2") }]);
  });

  test("a disconnected selection falls back to the system default", async () => {
    const calls: MediaStreamConstraints[] = [];
    mockMediaDevices({
      getUserMedia: async (constraints) => {
        calls.push(constraints ?? {});
        if (calls.length === 1) throw new DOMException("Gone", "OverconstrainedError");
        return stream;
      },
    });
    expect(await openMicrophone("mic-2")).toBe(stream);
    expect(calls).toEqual([
      { audio: voiceInputConstraints("mic-2") },
      { audio: voiceInputConstraints("") },
    ]);
  });

  test("permission failures and an unconstrained failure are not retried", async () => {
    let calls = 0;
    mockMediaDevices({
      getUserMedia: async () => {
        calls++;
        throw new DOMException("Denied", "NotAllowedError");
      },
    });
    await expect(openMicrophone("mic-2")).rejects.toThrow("Denied");
    expect(calls).toBe(1);

    calls = 0;
    mockMediaDevices({
      getUserMedia: async () => {
        calls++;
        throw new DOMException("Missing", "NotFoundError");
      },
    });
    await expect(openMicrophone("")).rejects.toThrow("Missing");
    expect(calls).toBe(1);
  });

  test("without getUserMedia the microphone needs HTTPS", async () => {
    mockMediaDevices({});
    await expect(openMicrophone("")).rejects.toThrow("Microphone needs HTTPS.");
  });
});
