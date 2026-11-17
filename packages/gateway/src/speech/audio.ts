import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrcConfig } from "@orc/core/config";

export type SpeechAudio = { audio: Uint8Array; format: string };
export type SynthesizedSpeech = { audio: Uint8Array; format: "mp3" | "ogg" };

export interface SpeechToText {
  transcribe(input: SpeechAudio & { signal?: AbortSignal }): Promise<string>;
}

export interface TextToSpeech {
  synthesize(text: string, signal?: AbortSignal): Promise<SynthesizedSpeech>;
}

export type SpeechToTextFactory = (config: OrcConfig) => SpeechToText | null;
export type TextToSpeechFactory = (config: OrcConfig) => TextToSpeech | null;

export function formatToExt(format: string): string {
  const normalized = format.toLowerCase();
  if (normalized === "oga" || normalized === "opus") return "ogg";
  if (normalized === "mpeg" || normalized === "mpga") return "mp3";
  return normalized;
}

export function mimeForFormat(format: string): string {
  const normalized = format.toLowerCase();
  if (normalized === "wav") return "audio/wav";
  if (normalized === "ogg" || normalized === "opus") return "audio/ogg";
  if (normalized === "mp4" || normalized === "m4a") return "audio/mp4";
  return "audio/mpeg";
}

export function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(60_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function convertAudio(
  input: Uint8Array,
  srcFormat: string,
  targetFormat: "mp3" | "ogg",
  timeoutMs = 60_000,
): Promise<Uint8Array> {
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg) throw new Error("ffmpeg is required for voice support.");
  const dir = await mkdtemp(join(tmpdir(), "orc-gateway-"));
  try {
    const sourcePath = join(dir, `input.${formatToExt(srcFormat)}`);
    const targetPath = join(dir, `output.${targetFormat}`);
    await writeFile(sourcePath, input);
    const args = ["-y", "-i", sourcePath];
    if (targetFormat === "mp3") args.push("-ac", "1", "-ar", "16000");
    if (targetFormat === "ogg") args.push("-c:a", "libopus");
    args.push(targetPath);
    const proc = Bun.spawn({
      cmd: [ffmpeg, ...args],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (proc.signalCode) throw new Error(`ffmpeg conversion timed out after ${timeoutMs}ms`);
    if (exitCode !== 0) throw new Error(stderr || "ffmpeg conversion failed");
    return new Uint8Array(await readFile(targetPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function transcribable(input: SpeechAudio): Promise<SpeechAudio> {
  if (["mp3", "wav", "webm", "m4a", "mp4"].includes(input.format.toLowerCase())) return input;
  return { audio: await convertAudio(input.audio, input.format, "mp3"), format: "mp3" };
}
