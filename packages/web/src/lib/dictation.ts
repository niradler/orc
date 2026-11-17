export const DICTATION_LIMIT_MS = 5 * 60_000;

export function insertDictation(
  draft: string,
  start: number,
  end: number,
  transcript: string,
): { value: string; caret: number } | null {
  const text = transcript.trim();
  if (!text) return null;
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const head = `${before}${before && !/\s$/.test(before) ? " " : ""}${text}`;
  const gap = after && !/^[\s.,!?;:)\]}]/.test(after) ? " " : "";
  return { value: `${head}${gap}${after}`, caret: head.length };
}

export function dictationLimitMs(maxBytes: number, sampleRate: number): number {
  if (maxBytes <= 0) return DICTATION_LIMIT_MS;
  return Math.min(DICTATION_LIMIT_MS, Math.floor(((maxBytes - 44) / (sampleRate * 2)) * 1000));
}

export function createDecimator(inputRate: number, outputRate: number) {
  const step = inputRate / outputRate;
  let position = 0;
  let sum = 0;
  let count = 0;
  return (channel: Float32Array): Float32Array => {
    const out: number[] = [];
    for (const sample of channel) {
      sum += sample;
      count++;
      if (++position >= step) {
        position -= step;
        out.push(sum / count);
        sum = 0;
        count = 0;
      }
    }
    return Float32Array.from(out);
  };
}

export function wavFile(chunks: Float32Array[], sampleRate: number): Uint8Array<ArrayBuffer> {
  const samples = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  let offset = 44;
  for (const chunk of chunks)
    for (const sample of chunk) {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  return new Uint8Array(view.buffer);
}

export function dictationClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function microphoneError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microphone blocked. Allow it in site settings.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found.";
  if (name === "NotReadableError") return "Microphone in use by another app.";
  return err instanceof Error ? err.message : "Microphone failed to start.";
}
