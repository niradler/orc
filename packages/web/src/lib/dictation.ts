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

export function recordingMime(supported: (type: string) => boolean): string {
  return (
    ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find(
      supported,
    ) ?? ""
  );
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
