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
  return serial(ws, "queue", async () =>
    ws.data.epoch === epoch && !ws.data.listening ? speakTo(ws, text) : false,
  );
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
    send(ws, { type: "speak", text: sentence, ...(speech ? { format: speech.format } : {}) });
    if (speech) ws.sendBinary(speech.audio);
  }
  return true;
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
    });
    send(ws, { type: "ready" });
  },
  message(ws, message) {
    if (typeof message === "string" || message.byteLength % 2) return;
    const pcm = new Int16Array(
      message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength),
    );
    for (const event of ws.data.detector?.push(pcm) ?? []) {
      if (event.type === "start") {
        ws.data.epoch = (ws.data.epoch ?? 0) + 1;
        ws.data.listening = true;
        ws.data.speaking?.abort();
        send(ws, { type: "speech_start" });
        continue;
      }
      send(ws, { type: "speech_end" });
      const audio = event.audio;
      if (!audio) {
        ws.data.listening = false;
        send(ws, { type: "ignored" });
        continue;
      }
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
    if (sockets.get(ws.data.threadId) === ws) sockets.delete(ws.data.threadId);
  },
};
