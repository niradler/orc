import { z } from "zod";
import { ID_LEN } from "./id-format.js";

export const SEND_ID_PATTERN = new RegExp(`^[a-z0-9]{${ID_LEN}}$`);

/**
 * Request headers the sender owns. A saved proxy header must not replace them,
 * mirroring the browser host store's blocked set: the destination call sets its
 * own Authorization, Content-Type and Accept.
 */
export const SEND_BLOCKED_HEADERS = new Set([
  "accept",
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "expect",
  "host",
  "origin",
  "proxy-authenticate",
  "proxy-authorization",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const sendHeaderSchema = z
  .object({
    name: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,128}$/, "Expected a valid header name")
      .refine(
        (name) => !SEND_BLOCKED_HEADERS.has(name.toLowerCase()),
        "Header is owned by the request",
      ),
    value: z.string().min(1).max(8192),
  })
  .strict();

/**
 * A destination ORC installation chosen from the client's saved hosts. The token
 * and proxy headers travel with this one request and are never stored on the
 * source server.
 */
export const SessionSendInputSchema = z
  .object({
    host_label: z.string().trim().min(1).max(200),
    url: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .transform((value) => value.replace(/\/+$/, ""))
      .refine((value) => {
        try {
          const parsed = new URL(value);
          return (
            (parsed.protocol === "http:" || parsed.protocol === "https:") &&
            !parsed.username &&
            !parsed.password
          );
        } catch {
          return false;
        }
      }, "Expected an absolute http(s) ORC address without credentials"),
    token: z.string().max(8192).default(""),
    headers: z.array(sendHeaderSchema).max(32).default([]),
    project: z.string().trim().min(1).max(200),
    note: z.string().trim().max(4000).default(""),
  })
  .strict();

export const SessionSendToRemoteHostSchema = z
  .object({
    remote_host: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    project: z.string().trim().min(1).max(200),
    note: z.string().trim().max(4000).default(""),
  })
  .strict();

export const SessionSendSchema = z.object({
  id: z.string(),
  live_session_id: z.string(),
  status: z.enum(["preparing", "ready", "error"]),
  host_label: z.string(),
  host_url: z.string(),
  project: z.string(),
  handoff_id: z.string().nullable(),
  remote_session_id: z.string().nullable(),
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  left_behind: z.array(z.string()),
  error: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

/** What the source can move, resolved before the user picks a destination project. */
export const SessionSendPreviewSchema = z.object({
  eligible: z.boolean(),
  reason: z.string().nullable(),
  agent: z.enum(["claude", "codex", "opencode", "pi"]).nullable(),
  repository: z.string().nullable(),
  remote: z.string(),
  branch: z.string().nullable(),
  cwd: z.string().nullable(),
  subdirectory: z.string(),
  title: z.string().nullable(),
});

export type SessionSendInput =
  | z.input<typeof SessionSendInputSchema>
  | z.input<typeof SessionSendToRemoteHostSchema>;
export type SessionSendRequest = z.output<typeof SessionSendInputSchema>;
export type SessionSend = z.infer<typeof SessionSendSchema>;
export type SessionSendPreview = z.infer<typeof SessionSendPreviewSchema>;
