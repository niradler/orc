import { randomBytes } from "node:crypto";
import { loadConfig } from "@orc/core/config";
import { createLogger } from "@orc/core/logger";
import {
  createTurnDetector,
  isFillerOnly,
  pcm16Wav,
  speechSentences,
  speechToText,
  textToSpeech,
} from "@orc/gateway";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { requireThread, sayInChat, voiceTurn } from "./routes/chat.js";

const logger = createLogger("api:voice");
const WS_PATH = /^(?:\/api)?\/chat\/threads\/([^/]+)\/voice$/;
const TICKET_TTL_MS = 30_000;
const ON_SCREEN = "It needs you on screen.";

export interface VoiceSocketData {
  threadId: string;
  detector?: ReturnType<typeof createTurnDetector>;
  speaking?: AbortController;
  listening?: boolean;
  epoch?: number;
  queue?: Promise<unknown>;
  turns?: Promise<unknown>;
  /** Clip ids sent for the current reply and still playing on the client. */
  clips?: Set<string>;
  clip?: number;
  sending?: boolean;
  guard?: ReturnType<typeof setTimeout>;
}

const tickets = new Map<string, { threadId: string; expiresAt: number }>();
const sockets = new Map<string, ServerWebSocket<VoiceSocketData>>();

export function mintVoiceTicket(threadId: string): { ticket: string; expires_in: number } {
  requireThread(threadId);
  const now = Date.now();
  for (const [token, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(token);
  const ticket = randomBytes(24).toString("base64url");
  tickets.set(ticket, { threadId, expiresAt: now + TICKET_TTL_MS });
  return { ticket, expires_in: TICKET_TTL_MS / 1000 };
}

export function handleVoiceUpgrade(
  req: Request,
  server: Server<VoiceSocketData>,
): Response | undefined | null {
  const url = new URL(req.url);
  const match = WS_PATH.exec(url.pathname);
  if (!match?.[1]) return null;
  const threadId = decodeURIComponent(match[1]);
  const entry = tickets.get(url.searchParams.get("ticket") ?? "");
  tickets.delete(url.searchParams.get("ticket") ?? "");
  if (!entry || entry.threadId !== threadId || entry.expiresAt <= Date.now())
    return new Response("Invalid or expired ticket", { status: 401 });
  if (server.upgrade(req, { data: { threadId } })) return undefined;
  return new Response("WebSocket upgrade failed", { status: 400 });
}

const errorText = (err: unknown) =>
  err instanceof Error ? err.message.slice(0, 300) : "Voice turn failed";

function send(ws: ServerWebSocket<VoiceSocketData>, message: Record<string, unknown>) {
  ws.send(JSON.stringify(message));
}

// A reply is "playing" from the first clip until the client confirms it played
// the last one. Barge-in is only evaluated during that window, and a stuck
// client must not leave the detector armed forever.
const REPLY_GUARD_MS = 600_000;

function endReply(ws: ServerWebSocket<VoiceSocketData>) {
  if (ws.data.guard) clearTimeout(ws.data.guard);
  delete ws.data.guard;
  ws.data.clips?.clear();
  ws.data.sending = false;
  ws.data.detector?.setSpeaking(false);
}

function maybeEndReply(ws: ServerWebSocket<VoiceSocketData>) {
  if (ws.data.sending) return;
  if (!ws.data.clips?.size) endReply(ws);
}

function beginReply(ws: ServerWebSocket<VoiceSocketData>) {
  ws.data.clips = new Set();
  ws.data.sending = true;
  ws.data.detector?.setSpeaking(true);
  if (ws.data.guard) clearTimeout(ws.data.guard);
  ws.data.guard = setTimeout(() => endReply(ws), REPLY_GUARD_MS);
}

function serial<T>(
  ws: ServerWebSocket<VoiceSocketData>,
  lane: "queue" | "turns",
  work: () => Promise<T>,
): Promise<T> {
  const next = (ws.data[lane] ?? Promise.resolve()).then(work);
  ws.data[lane] = next.catch(() => {});
  return next;
}

function enqueueSpeech(ws: ServerWebSocket<VoiceSocketData>, text: string): Promise<boolean> {
  const epoch = ws.data.epoch;
  return serial(ws, "queue", async () => {
    if (ws.data.epoch !== epoch) {
      logger.debug("voice: dropped speech replaced by a newer turn", {
        threadId: ws.data.threadId,
      });
      return false;
    }
    if (ws.data.listening) {
      logger.debug("voice: skipped speech while the user is talking", {
        threadId: ws.data.threadId,
      });
      return false;
    }
    return speakTo(ws, text);
  });
}

async function hear(ws: ServerWebSocket<VoiceSocketData>, audio: Int16Array) {
  const stt = speechToText(loadConfig(), "voice_mode");
  if (!stt) return send(ws, { type: "error", message: "Speech is not configured on this server." });
  const text = (await stt.transcribe({ audio: pcm16Wav(audio), format: "wav" })).trim();
  ws.data.listening = false;
  if (!text || isFillerOnly(text)) return send(ws, { type: "ignored" });
  send(ws, { type: "transcript", text });
  if ((await voiceTurn(ws.data.threadId, text)) === "waiting") await enqueueSpeech(ws, ON_SCREEN);
}

async function speakTo(ws: ServerWebSocket<VoiceSocketData>, text: string): Promise<boolean> {
  const controller = new AbortController();
  ws.data.speaking = controller;
  // The barge rule follows playback, not a synthesis wait: until the first clip
  // is on its way, the user is simply talking.
  let playing = false;
  const arm = () => {
    if (playing) return;
    playing = true;
    beginReply(ws);
  };
  try {
    const tts = textToSpeech(loadConfig(), "voice_mode");
    const sentences = speechSentences(text);
    const synth = (sentence?: string) =>
      sentence && tts ? tts.synthesize(sentence, controller.signal) : Promise.resolve(null);
    let next = synth(sentences[0]);
    for (const [index, sentence] of sentences.entries()) {
      const speech = await next.catch((err) => {
        if (controller.signal.aborted) return null;
        logger.warn("Voice synthesis failed", err);
        send(ws, { type: "error", message: errorText(err) });
        return null;
      });
      if (controller.signal.aborted || ws.readyState !== WebSocket.OPEN) return false;
      next = synth(sentences[index + 1]);
      let id: string | undefined;
      if (speech) {
        arm();
        ws.data.clip = (ws.data.clip ?? 0) + 1;
        id = String(ws.data.clip);
        ws.data.clips?.add(id);
      }
      send(ws, {
        type: "speak",
        ...(id ? { id } : {}),
        text: sentence,
        ...(speech ? { format: speech.format } : {}),
      });
      if (speech) ws.sendBinary(speech.audio);
    }
    return true;
  } finally {
    if (playing) {
      ws.data.sending = false;
      maybeEndReply(ws);
    }
    if (ws.data.speaking === controller) delete ws.data.speaking;
  }
}

/** Load the TTS backend while the microphone is already open, so the first
 *  reply does not pay for a cold model load. */
function warmSpeech(): void {
  const tts = textToSpeech(loadConfig(), "voice_mode");
  if (!tts) return;
  tts.synthesize("Ready.", AbortSignal.timeout(30_000)).catch((err) => {
    logger.debug("Voice warm-up failed", err);
  });
}

export async function speak(
  threadId: string,
  text: string,
): Promise<{ posted: boolean; spoken: boolean }> {
  const posted = await sayInChat(threadId, text);
  const ws = sockets.get(threadId);
  const spoken = ws ? await enqueueSpeech(ws, text) : false;
  return { posted, spoken };
}

export function voiceNotice(threadId: string): void {
  const ws = sockets.get(threadId);
  if (ws) void enqueueSpeech(ws, ON_SCREEN);
}

export const voiceWebsocket: WebSocketHandler<VoiceSocketData> = {
  open(ws) {
    const { voice_mode } = loadConfig().speech;
    sockets.get(ws.data.threadId)?.close(4000, "Voice mode opened elsewhere");
    sockets.set(ws.data.threadId, ws);
    ws.data.detector = createTurnDetector({
      silenceMs: voice_mode.silence_ms,
      thresholdDb: voice_mode.threshold_db,
      bargeMs: voice_mode.barge_ms,
    });
    send(ws, { type: "ready" });
    warmSpeech();
  },
  message(ws, message) {
    if (typeof message === "string") {
      try {
        const event = JSON.parse(message) as { type?: unknown; id?: unknown };
        if (event.type === "played" && typeof event.id === "string") {
          ws.data.clips?.delete(event.id);
          maybeEndReply(ws);
        }
      } catch {}
      return;
    }
    if (message.byteLength % 2) return;
    const pcm = new Int16Array(
      message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength),
    );
    for (const event of ws.data.detector?.push(pcm) ?? []) {
      if (event.type === "start") {
        ws.data.listening = true;
        send(ws, { type: "speech_start" });
        continue;
      }
      if (event.type === "barge") {
        // The user is really talking over the reply: stop it now.
        ws.data.epoch = (ws.data.epoch ?? 0) + 1;
        ws.data.speaking?.abort();
        endReply(ws);
        logger.info("voice: barge-in", { threadId: ws.data.threadId });
        send(ws, { type: "barge" });
        continue;
      }
      const audio = event.audio;
      if (!audio) {
        ws.data.listening = false;
        send(ws, { type: "speech_cancelled" });
        continue;
      }
      // A confirmed request replaces whatever the agent was saying, including
      // speech queued but not yet played.
      ws.data.epoch = (ws.data.epoch ?? 0) + 1;
      ws.data.speaking?.abort();
      endReply(ws);
      send(ws, { type: "speech_end" });
      void serial(ws, "turns", () =>
        hear(ws, audio).finally(() => {
          ws.data.listening = false;
        }),
      ).catch((err) => {
        logger.warn("Voice turn failed", err);
        send(ws, { type: "error", message: errorText(err) });
      });
    }
  },
  close(ws) {
    ws.data.speaking?.abort();
    endReply(ws);
    if (sockets.get(ws.data.threadId) === ws) sockets.delete(ws.data.threadId);
  },
};
