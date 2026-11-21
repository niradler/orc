import { useQuery } from "@tanstack/react-query";
import { AudioLines, CircleAlert, LoaderCircle, Mic, MicOff, Square, Volume2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiSocketUrl } from "@/api/client";
import { ActionHelp } from "@/components/ActionHelp";
import {
  captureWorklet,
  DICTATION_RATE,
  DictationLevel,
  keepFocus,
  touchTarget,
} from "@/components/ChatDictation";
import { microphoneError } from "@/lib/dictation";
import { cn } from "@/lib/utils";
import { getVoiceInputDevice, openMicrophone } from "@/lib/voice-input";

export type VoiceMode = ReturnType<typeof useVoiceMode>;
type VoiceEvent = { type: string; text?: string; message?: string };

export const VOICE_SHORTCUT =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
    ? "⌘⇧Space"
    : "Ctrl+Shift+Space";

export function isVoiceShortcut(event: {
  code: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  repeat?: boolean;
}) {
  return (
    !event.repeat && event.shiftKey && (event.metaKey || event.ctrlKey) && event.code === "Space"
  );
}

export function useVoiceMode(threadId: string | undefined, streaming: boolean) {
  const status = useQuery({ queryKey: ["speech-status"], queryFn: api.speech.status });
  const [active, setActive] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [hearing, setHearing] = useState(false);
  const [pending, setPending] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState("");
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const teardown = useRef<(() => void) | null>(null);
  const track = useRef<MediaStreamTrack | null>(null);
  const attempt = useRef(0);

  const stop = useCallback(() => {
    attempt.current++;
    teardown.current?.();
    teardown.current = null;
    track.current = null;
    setActive(false);
    setConnecting(false);
    setHearing(false);
    setPending(false);
    setPlaying(false);
    setMuted(false);
    setError("");
    setAnalyser(null);
  }, []);

  const start = useCallback(async () => {
    if (!threadId || teardown.current) return;
    const run = ++attempt.current;
    setActive(true);
    setConnecting(true);
    setError("");
    const context = new AudioContext();
    let stream: MediaStream | null = null;
    let socket: WebSocket | null = null;
    const sources = new Set<AudioBufferSourceNode>();
    const release = () => {
      socket?.close();
      for (const source of sources) source.stop();
      for (const t of stream?.getTracks() ?? []) t.stop();
      void context.close().catch(() => {});
    };
    teardown.current = release;
    const fail = (message: string) => {
      if (run !== attempt.current) return;
      release();
      setConnecting(false);
      setAnalyser(null);
      setError(message);
    };
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone needs HTTPS.");
      const resumed = context.resume();
      stream = await openMicrophone(getVoiceInputDevice());
      await resumed.catch(() => {});
      if (run !== attempt.current) return release();
      if (context.state !== "running") throw new Error("Audio didn't start. Tap Stop and retry.");
      const workletUrl = URL.createObjectURL(
        new Blob([captureWorklet], { type: "text/javascript" }),
      );
      try {
        await context.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }
      const { ticket } = await api.speech.voiceTicket(threadId);
      if (run !== attempt.current) return release();
      socket = new WebSocket(
        apiSocketUrl(
          `/chat/threads/${encodeURIComponent(threadId)}/voice?ticket=${encodeURIComponent(ticket)}`,
        ),
      );
      socket.binaryType = "arraybuffer";
      const ws = socket;
      track.current = stream.getAudioTracks()[0] ?? null;
      const input = context.createMediaStreamSource(stream);
      const capture = new AudioWorkletNode(context, "pcm-capture", { numberOfOutputs: 0 });
      capture.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
        if (ws.readyState !== WebSocket.OPEN || context.sampleRate < DICTATION_RATE) return;
        const pcm = new Int16Array(data.length);
        for (const [i, sample] of data.entries())
          pcm[i] = Math.max(-1, Math.min(1, sample)) * 0x7fff;
        ws.send(pcm.buffer);
      };
      input.connect(capture);
      const node = context.createAnalyser();
      node.fftSize = 512;
      input.connect(node);
      let playAt = 0;
      let epoch = 0;
      let decoding = Promise.resolve();
      const silence = () => {
        epoch++;
        playAt = 0;
        for (const source of sources) source.stop();
        sources.clear();
        setPlaying(false);
      };
      ws.onmessage = ({ data }: MessageEvent<string | ArrayBuffer>) => {
        if (run !== attempt.current) return;
        if (typeof data !== "string") {
          const turn = epoch;
          decoding = decoding.then(async () => {
            const audio = await context.decodeAudioData(data).catch(() => null);
            if (!audio || turn !== epoch || context.state === "closed") return;
            const source = context.createBufferSource();
            source.buffer = audio;
            source.connect(context.destination);
            playAt = Math.max(playAt, context.currentTime);
            source.start(playAt);
            playAt += audio.duration;
            sources.add(source);
            setPlaying(true);
            source.onended = () => {
              sources.delete(source);
              if (!sources.size) setPlaying(false);
            };
          });
          return;
        }
        const event = JSON.parse(data) as VoiceEvent;
        if (event.type === "ready") {
          setConnecting(false);
          setAnalyser(node);
        } else if (event.type === "speech_start") {
          silence();
          setError("");
          setHearing(true);
        } else if (event.type === "speech_end") {
          setHearing(false);
          setPending(true);
        } else if (event.type === "ignored" || event.type === "speak") {
          setPending(false);
        } else if (event.type === "error") {
          setPending(false);
          setError(event.message ?? "Voice turn failed.");
        }
      };
      ws.onclose = (event) => {
        if (run === attempt.current)
          fail(event.code === 4000 ? "Voice mode opened elsewhere." : "Voice mode disconnected.");
      };
    } catch (err) {
      fail(microphoneError(err));
    }
  }, [threadId]);

  const toggleMute = useCallback(() => {
    setMuted((value) => {
      if (track.current) track.current.enabled = value;
      return !value;
    });
  }, []);

  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (wasStreaming.current && !streaming) setPending(false);
    wasStreaming.current = streaming;
  }, [streaming]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || (event.key !== "Escape" && !isVoiceShortcut(event))) return;
      event.preventDefault();
      event.stopPropagation();
      stop();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, stop]);

  useEffect(() => {
    if (threadId) return stop;
  }, [threadId, stop]);

  const cue = error
    ? "error"
    : connecting
      ? "connecting"
      : hearing
        ? "hearing"
        : playing
          ? "speaking"
          : pending || streaming
            ? "thinking"
            : "listening";

  return {
    available: status.data?.voice_mode === true && !!threadId,
    active,
    cue,
    muted,
    error,
    analyser,
    start,
    stop,
    toggleMute,
  } as const;
}

export function ChatVoiceButton({ voice, disabled }: { voice: VoiceMode; disabled: boolean }) {
  if (!voice.available) return null;
  return (
    <ActionHelp label={`Voice mode (${VOICE_SHORTCUT})`}>
      <button
        type="button"
        data-testid="chat-voice-button"
        aria-label="Voice mode"
        disabled={disabled}
        onPointerDown={keepFocus}
        onClick={() => void voice.start()}
        className={cn(
          touchTarget,
          "text-on-surface-variant hover:bg-surface hover:text-on-surface disabled:opacity-40",
        )}
      >
        <AudioLines size={16} />
      </button>
    </ActionHelp>
  );
}

const CUES = {
  connecting: { label: "Connecting", icon: LoaderCircle, spin: true },
  listening: { label: "Listening", icon: Mic, spin: false },
  hearing: { label: "Hearing you", icon: AudioLines, spin: false },
  thinking: { label: "Thinking", icon: LoaderCircle, spin: true },
  speaking: { label: "Speaking", icon: Volume2, spin: false },
  error: { label: "Voice off", icon: CircleAlert, spin: false },
} as const;

export function ChatVoiceOverlay({ voice }: { voice: VoiceMode }) {
  const cue = CUES[voice.cue];
  const Icon = cue.icon;
  return (
    <div
      data-testid="chat-voice-overlay"
      data-cue={voice.cue}
      data-muted={voice.muted ? "true" : "false"}
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 rounded-full bg-surface-high py-0.5 pr-1 pl-3 text-on-surface",
        voice.cue === "hearing" && "ring-1 ring-primary/60",
        voice.cue === "speaking" && "ring-1 ring-tertiary/60",
      )}
    >
      <span role="status" className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        <Icon
          size={15}
          className={cn(
            "shrink-0",
            cue.spin && "motion-safe:animate-spin",
            voice.cue === "error" ? "text-error" : "text-on-surface-variant",
          )}
        />
        {voice.cue === "error" ? (
          <span
            data-testid="chat-voice-error"
            title={voice.error}
            className="line-clamp-2 text-xs text-error"
          >
            {voice.error}
          </span>
        ) : (
          <span data-testid="chat-voice-cue" className="truncate">
            {voice.muted ? "Muted" : cue.label}
          </span>
        )}
        {voice.analyser && !voice.muted && voice.cue !== "error" && (
          <DictationLevel analyser={voice.analyser} testId="chat-voice-level" bar="bg-primary" />
        )}
      </span>
      {voice.cue !== "error" && voice.cue !== "connecting" && (
        <ActionHelp label={voice.muted ? "Unmute" : "Mute"}>
          <button
            type="button"
            data-testid="chat-voice-mute"
            aria-label={voice.muted ? "Unmute" : "Mute"}
            aria-pressed={voice.muted}
            onPointerDown={keepFocus}
            onClick={voice.toggleMute}
            className={cn(
              touchTarget,
              "rounded-full text-on-surface-variant hover:bg-surface",
              voice.muted && "bg-surface text-on-surface",
            )}
          >
            {voice.muted ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
        </ActionHelp>
      )}
      <ActionHelp label="Stop voice mode (Esc)">
        <button
          type="button"
          data-testid="chat-voice-stop"
          aria-label="Stop voice mode"
          onPointerDown={keepFocus}
          onClick={voice.stop}
          className={cn(touchTarget, "rounded-full bg-primary text-primary-foreground")}
        >
          <Square size={14} />
        </button>
      </ActionHelp>
    </div>
  );
}
