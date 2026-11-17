import { useQuery } from "@tanstack/react-query";
import { Check, CircleAlert, LoaderCircle, Mic, RotateCcw, X } from "lucide-react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/api/client";
import { ActionHelp } from "@/components/ActionHelp";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DICTATION_LIMIT_MS,
  dictationClock,
  insertDictation,
  microphoneError,
  recordingMime,
} from "@/lib/dictation";
import { cn } from "@/lib/utils";

type Phase = "idle" | "starting" | "recording" | "transcribing" | "error";
export type Dictation = ReturnType<typeof useDictation>;

const touchTarget =
  "inline-flex min-h-8 min-w-8 items-center justify-center rounded-md max-sm:min-h-11 max-sm:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11";
const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();

export const DICTATION_SHORTCUT =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
    ? "⌘⇧D"
    : "Ctrl+Shift+D";

export function isDictationShortcut(event: {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  repeat?: boolean;
}) {
  return (
    !event.repeat &&
    event.shiftKey &&
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "d"
  );
}

export function useDictation(
  input: RefObject<HTMLTextAreaElement | null>,
  setDraft: (value: string) => void,
) {
  const status = useQuery({ queryKey: ["speech-status"], queryFn: api.speech.status });
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [startedAt, setStartedAt] = useState(0);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const release = useRef<() => void>(() => {});
  const discard = useRef(false);
  const clip = useRef<Blob | null>(null);
  const request = useRef<AbortController | null>(null);
  const attempt = useRef(0);

  const transcribe = useCallback(
    async (audio: Blob) => {
      clip.current = audio;
      setPhase("transcribing");
      const controller = new AbortController();
      request.current = controller;
      try {
        const text = await api.speech.transcribe(audio, controller.signal);
        const field = input.current;
        const draft = field?.value ?? "";
        const end = field?.selectionEnd ?? draft.length;
        const next = insertDictation(draft, field?.selectionStart ?? end, end, text);
        clip.current = null;
        if (!next) {
          setError("Nothing heard.");
          setPhase("error");
          return;
        }
        setDraft(next.value);
        requestAnimationFrame(() => {
          input.current?.focus();
          input.current?.setSelectionRange(next.caret, next.caret);
        });
        setPhase("idle");
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 400) clip.current = null;
        setError(err instanceof Error ? err.message : "Transcription failed.");
        setPhase("error");
      }
    },
    [input, setDraft],
  );

  const start = useCallback(async () => {
    if (recorder.current) return;
    const run = ++attempt.current;
    const stale = () => run !== attempt.current;
    setError("");
    clip.current = null;
    discard.current = false;
    setPhase("starting");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone needs HTTPS.");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (stale()) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const mimeType = recordingMime((type) => MediaRecorder.isTypeSupported(type));
      const media = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      let context: AudioContext | null = null;
      try {
        context = new AudioContext();
        const node = context.createAnalyser();
        node.fftSize = 512;
        context.createMediaStreamSource(stream).connect(node);
        setAnalyser(node);
      } catch {
        setAnalyser(null);
      }
      const limit = setTimeout(
        () => media.state === "recording" && media.stop(),
        DICTATION_LIMIT_MS,
      );
      release.current = () => {
        clearTimeout(limit);
        for (const track of stream.getTracks()) track.stop();
        void context?.close().catch(() => {});
        setAnalyser(null);
        recorder.current = null;
      };
      media.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      media.onstop = () => {
        release.current();
        if (discard.current) {
          setPhase("idle");
          return;
        }
        void transcribe(new Blob(chunks, { type: media.mimeType || mimeType || "audio/webm" }));
      };
      recorder.current = media;
      media.start(1000);
      setStartedAt(Date.now());
      setPhase("recording");
    } catch (err) {
      if (stale()) return;
      release.current();
      setError(microphoneError(err));
      setPhase("error");
    }
  }, [transcribe]);

  const stop = useCallback(() => {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }, []);

  const cancel = useCallback(() => {
    discard.current = true;
    attempt.current++;
    if (recorder.current) {
      recorder.current.stop();
      return;
    }
    request.current?.abort();
    clip.current = null;
    setError("");
    setPhase("idle");
  }, []);

  const retry = useCallback(() => {
    if (clip.current) void transcribe(clip.current);
    else void start();
  }, [start, transcribe]);

  const toggle = useCallback(() => {
    if (phase === "recording") stop();
    else if (phase === "idle" || phase === "error") void start();
  }, [phase, start, stop]);

  useEffect(() => {
    if (phase === "idle") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const handled =
        isDictationShortcut(event) ||
        event.key === "Escape" ||
        (event.key === "Enter" && !event.shiftKey && phase === "recording");
      if (!handled) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") cancel();
      else if (phase === "recording") stop();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [phase, cancel, stop]);

  useEffect(
    () => () => {
      discard.current = true;
      attempt.current++;
      recorder.current?.stop();
      request.current?.abort();
    },
    [],
  );

  return {
    available: status.data?.available === true,
    phase,
    error,
    startedAt,
    analyser,
    busy: phase === "starting" || phase === "recording" || phase === "transcribing",
    start,
    stop,
    cancel,
    retry,
    toggle,
  };
}

export function ChatDictationButton({
  dictation,
  disabled,
}: {
  dictation: Dictation;
  disabled: boolean;
}) {
  if (!dictation.available)
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="chat-dictation-button"
            data-available="false"
            aria-label="Dictation off"
            className={cn(touchTarget, "text-outline hover:bg-surface hover:text-on-surface")}
          >
            <Mic size={16} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          data-testid="chat-dictation-unavailable"
          align="start"
          className="w-auto text-sm"
        >
          Dictation off ·{" "}
          <a
            className="text-primary underline"
            href="https://niradler.github.io/orc/docs/configuration#speech-tts"
            target="_blank"
            rel="noreferrer"
          >
            Set up
          </a>
        </PopoverContent>
      </Popover>
    );
  return (
    <ActionHelp label={`Dictate (${DICTATION_SHORTCUT})`}>
      <button
        type="button"
        data-testid="chat-dictation-button"
        data-available="true"
        aria-label="Dictate"
        disabled={disabled}
        onPointerDown={keepFocus}
        onClick={() => void dictation.start()}
        className={cn(
          touchTarget,
          "text-on-surface-variant hover:bg-surface hover:text-on-surface disabled:opacity-40",
        )}
      >
        <Mic size={16} />
      </button>
    </ActionHelp>
  );
}

function DictationLevel({ analyser }: { analyser: AnalyserNode | null }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!analyser) return;
    const samples = new Uint8Array(analyser.fftSize);
    let frame = 0;
    let smooth = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
      const target = Math.min(1, Math.sqrt(sum / samples.length) * 4);
      smooth = target > smooth ? target : smooth * 0.85 + target * 0.15;
      setLevel(smooth);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [analyser]);
  return (
    <span
      data-testid="chat-dictation-level"
      data-level={level.toFixed(2)}
      aria-hidden
      className="flex h-4 items-center gap-0.5"
    >
      {[0.5, 0.8, 1, 0.8, 0.5].map((weight, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed bar positions
          key={index}
          className="w-1 rounded-full bg-error transition-[height] duration-75"
          style={{ height: `${4 + Math.round(12 * Math.min(1, level * weight * 2.5))}px` }}
        />
      ))}
    </span>
  );
}

function DictationClock({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  return (
    <span data-testid="chat-dictation-elapsed" className="font-mono text-xs tabular-nums">
      {dictationClock(now - startedAt)}
    </span>
  );
}

export function ChatDictationPill({ dictation }: { dictation: Dictation }) {
  const { phase } = dictation;
  return (
    <div
      data-testid="chat-dictation-pill"
      data-phase={phase}
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1 rounded-full bg-surface-high pr-1 text-on-surface",
        phase === "recording" && "ring-1 ring-error/60",
      )}
    >
      <ActionHelp label={phase === "error" ? "Dismiss" : "Cancel (Esc)"}>
        <button
          type="button"
          data-testid="chat-dictation-cancel"
          aria-label={phase === "error" ? "Dismiss" : "Cancel"}
          onPointerDown={keepFocus}
          onClick={dictation.cancel}
          className={cn(touchTarget, "rounded-full text-on-surface-variant hover:bg-surface")}
        >
          <X size={16} />
        </button>
      </ActionHelp>
      <span role="status" className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        {phase === "recording" && (
          <>
            <span className="size-2.5 shrink-0 rounded-full bg-error motion-safe:animate-pulse" />
            <span className="sr-only">Recording</span>
            <DictationClock startedAt={dictation.startedAt} />
            <DictationLevel analyser={dictation.analyser} />
          </>
        )}
        {(phase === "starting" || phase === "transcribing") && (
          <>
            <LoaderCircle size={14} className="shrink-0 motion-safe:animate-spin" />
            <span className="sr-only">{phase === "starting" ? "Starting" : "Transcribing"}</span>
          </>
        )}
        {phase === "error" && (
          <>
            <CircleAlert size={14} className="shrink-0 text-error" />
            <span
              data-testid="chat-dictation-error"
              title={dictation.error}
              className="line-clamp-2 text-xs text-error"
            >
              {dictation.error}
            </span>
          </>
        )}
      </span>
      {phase === "recording" && (
        <ActionHelp label="Insert (Enter)">
          <button
            type="button"
            data-testid="chat-dictation-stop"
            aria-label="Insert"
            onPointerDown={keepFocus}
            onClick={dictation.stop}
            className={cn(touchTarget, "rounded-full bg-primary text-primary-foreground")}
          >
            <Check size={16} />
          </button>
        </ActionHelp>
      )}
      {phase === "error" && (
        <ActionHelp label="Retry">
          <button
            type="button"
            data-testid="chat-dictation-retry"
            aria-label="Retry"
            onPointerDown={keepFocus}
            onClick={dictation.retry}
            className={cn(touchTarget, "rounded-full text-on-surface-variant hover:bg-surface")}
          >
            <RotateCcw size={16} />
          </button>
        </ActionHelp>
      )}
    </div>
  );
}
