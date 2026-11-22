import { z } from "zod";

/**
 * Wire contract between the ORC buddy bridge and a device (ESP32 CYD firmware).
 * One UTF-8 JSON object per line, terminated with "\n". docs/docs/buddy.md is
 * the human-readable spec; the firmware (issue #514) implements the same shapes.
 * Bump the version on any breaking change.
 */
export const BUDDY_PROTOCOL_VERSION = 1;
/** Lines larger than this are dropped: ESP32 RAM is finite and snapshots are compact. */
export const BUDDY_MAX_LINE_BYTES = 64 * 1024;
/** Bridge re-sends the snapshot this often so the device can detect a dead link. */
export const BUDDY_KEEPALIVE_MS = 10_000;
/** Device goes to sleep after this long without a snapshot. */
export const BUDDY_LINK_TIMEOUT_MS = 30_000;

/** `sleep` is device-side (link loss); the bridge never sends it. */
export const BuddyMoodSchema = z.enum(["idle", "busy", "attention", "celebrate", "error"]);
export type BuddyMood = z.infer<typeof BuddyMoodSchema>;

export const BuddyNeedsYouSchema = z
  .object({
    /**
     * Human request id as-is; chat-run requests as `chat:<runId>:<requestId>`;
     * native terminal waits as `native:<sessionId>` (display-only).
     */
    id: z.string().min(1).max(300),
    kind: z.enum(["approval", "question", "native"]),
    title: z.string().max(200),
    hint: z.string().max(300),
    project: z.string().max(80).nullable(),
    /** False when the device cannot answer it (free-text question, native prompt). */
    actionable: z.boolean(),
    choices: z.array(z.string().max(200)).max(20).optional(),
  })
  .strict();
export type BuddyNeedsYou = z.infer<typeof BuddyNeedsYouSchema>;

export const BuddySnapshotSchema = z
  .object({
    v: z.literal(BUDDY_PROTOCOL_VERSION),
    /** Unix seconds. */
    t: z.number().int().nonnegative(),
    mood: BuddyMoodSchema,
    sessions: z
      .object({
        total: z.number().int().nonnegative(),
        working: z.number().int().nonnegative(),
        waiting: z.number().int().nonnegative(),
      })
      .strict(),
    needs_you: z.array(BuddyNeedsYouSchema).max(20),
    recent: z
      .array(
        z
          .object({
            id: z.string().min(1).max(300),
            line: z.string().max(160),
            unread: z.boolean(),
          })
          .strict(),
      )
      .max(6),
    unread: z.number().int().nonnegative(),
    tokens_today: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type BuddySnapshot = z.infer<typeof BuddySnapshotSchema>;

/** Device → bridge. Every command expects a matching ack. */
export const BuddyCommandSchema = z.discriminatedUnion("cmd", [
  z
    .object({
      cmd: z.literal("respond"),
      id: z.string().min(1).max(300),
      decision: z.enum(["approve", "deny"]),
    })
    .strict(),
  z
    .object({
      cmd: z.literal("answer"),
      id: z.string().min(1).max(300),
      choice: z.string().min(1).max(2000),
    })
    .strict(),
  z.object({ cmd: z.literal("read"), id: z.string().min(1).max(300) }).strict(),
  z.object({ cmd: z.literal("ping") }).strict(),
]);
export type BuddyCommand = z.infer<typeof BuddyCommandSchema>;

/** Bridge → device commands (provisioning and diagnostics). Device acks each. */
export const BuddyHostCommandSchema = z.discriminatedUnion("cmd", [
  z
    .object({
      cmd: z.literal("config"),
      /** ORC API base URL for HTTP mode, e.g. http://192.168.1.20:7700 */
      url: z.string().min(1).max(300).optional(),
      /** Scoped access token for HTTP mode (never the API secret). */
      token: z.string().min(1).max(2000).optional(),
      ssid: z.string().min(1).max(64).optional(),
      pass: z.string().max(128).optional(),
      name: z.string().min(1).max(40).optional(),
    })
    .strict(),
  z.object({ cmd: z.literal("status") }).strict(),
  z.object({ cmd: z.literal("unpair") }).strict(),
]);
export type BuddyHostCommand = z.infer<typeof BuddyHostCommandSchema>;

export const BuddyAckSchema = z
  .object({
    ack: z.string().min(1).max(40),
    ok: z.boolean(),
    error: z.string().max(300).optional(),
    data: z.unknown().optional(),
  })
  .strict();
export type BuddyAck = z.infer<typeof BuddyAckSchema>;

export function encodeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Accumulates serial/TCP chunks into parsed JSON lines. Non-JSON lines are
 * skipped: the ESP32 boot ROM and firmware logs share the same UART.
 */
export class LineDecoder {
  private buffer = "";

  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const out: unknown[] = [];
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line && Buffer.byteLength(line, "utf8") <= BUDDY_MAX_LINE_BYTES) {
        try {
          out.push(JSON.parse(line));
        } catch {
          // Boot noise or a partial write; not a protocol line.
        }
      }
      index = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer, "utf8") > BUDDY_MAX_LINE_BYTES) this.buffer = "";
    return out;
  }
}
