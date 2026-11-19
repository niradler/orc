import { createRoute, z } from "@hono/zod-openapi";
import { loadConfig } from "@orc/core/config";
import { OrcError, ValidationError } from "@orc/core/errors";
import { speechToText } from "@orc/gateway";
import { bodyLimit } from "hono/body-limit";
import { createRouter } from "../lib/router.js";
import { mintVoiceTicket, speak } from "../voice.js";

const app = createRouter();

const SPEECH_MAX_BYTES = 25 * 1024 * 1024;

app.openapi(
  createRoute({
    method: "get",
    path: "/speech/status",
    tags: ["Speech"],
    summary: "Whether composer dictation and voice mode can transcribe audio",
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z
              .object({
                available: z.boolean(),
                max_bytes: z.number().int(),
                voice_mode: z.boolean(),
              })
              .openapi("SpeechStatus"),
          },
        },
        description: "Speech availability",
      },
    },
  }),
  (c) => {
    const stt = speechToText(loadConfig(), "dictation");
    return c.json({
      available: stt !== null,
      max_bytes: stt?.maxBytes ?? 0,
      voice_mode: speechToText(loadConfig(), "voice_mode") !== null,
    });
  },
);

app.use(
  "/speech/transcribe",
  bodyLimit({
    maxSize: SPEECH_MAX_BYTES + 64 * 1024,
    onError: (c) => c.json({ error: "Recording exceeds 25 MB", code: "TOO_LARGE" }, 413),
  }),
);
app.openapi(
  createRoute({
    method: "post",
    path: "/speech/transcribe",
    tags: ["Speech"],
    summary: "Transcribe a recorded clip with the configured speech provider",
    request: {
      body: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: z.object({
              audio: z.instanceof(File).openapi({ type: "string", format: "binary" }),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ text: z.string() }).openapi("SpeechTranscript"),
          },
        },
        description: "Transcript",
      },
    },
  }),
  async (c) => {
    const stt = speechToText(loadConfig(), "dictation");
    if (!stt)
      throw new OrcError("Speech is not configured on this server.", "SPEECH_UNAVAILABLE", 409);
    const { audio } = c.req.valid("form");
    if (!audio.size) throw new ValidationError("Recording is empty");
    if (audio.size > stt.maxBytes)
      throw new OrcError(
        `Recording exceeds ${(stt.maxBytes / 1_000_000).toFixed(1)} MB`,
        "TOO_LARGE",
        413,
      );
    const subtype = audio.type.split(";")[0]?.split("/")[1]?.replace(/^x-/, "") ?? "";
    const format =
      { webm: "webm", mp4: "mp4", m4a: "m4a", mpeg: "mp3", mp3: "mp3", wav: "wav", ogg: "ogg" }[
        subtype
      ] ?? "webm";
    try {
      const text = await stt.transcribe({
        signal: c.req.raw.signal,
        audio: new Uint8Array(await audio.arrayBuffer()),
        format,
      });
      return c.json({ text });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new OrcError(
        message.replace(/\b(sk|gsk)[-_][\w*.-]+/g, "[redacted]").slice(0, 500),
        "SPEECH_FAILED",
        502,
      );
    }
  },
);

const threadParams = z.object({ id: z.string().min(1).max(200) });

app.openapi(
  createRoute({
    method: "post",
    path: "/chat/threads/{id}/voice/ticket",
    tags: ["Speech"],
    summary: "Mint a single-use ticket for the conversation's voice-mode WebSocket",
    request: { params: threadParams },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ ticket: z.string(), expires_in: z.number() }).openapi("VoiceTicket"),
          },
        },
        description: "Ticket for /api/chat/threads/{id}/voice?ticket=",
      },
    },
  }),
  (c) => {
    if (!speechToText(loadConfig(), "voice_mode"))
      throw new OrcError("Speech is not configured on this server.", "SPEECH_UNAVAILABLE", 409);
    return c.json(mintVoiceTicket(c.req.valid("param").id), 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/chat/threads/{id}/speak",
    tags: ["Speech"],
    summary: "Post a spoken line to the conversation and play it in its voice mode",
    request: {
      params: threadParams,
      body: {
        required: true,
        content: {
          "application/json": { schema: z.object({ text: z.string().trim().min(1).max(4000) }) },
        },
      },
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ posted: z.boolean(), spoken: z.boolean() }).openapi("SpeakResult"),
          },
        },
        description: "Whether the line reached the transcript and the voice-mode speaker",
      },
    },
  }),
  async (c) => c.json(await speak(c.req.valid("param").id, c.req.valid("json").text), 200),
);

export { app as gatewayRouter };
