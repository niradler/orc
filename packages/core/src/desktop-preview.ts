import { z } from "zod";

export function previewWebUrl(value: string): string | null {
  if (
    value.length > 8192 ||
    [...value].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  )
    return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

const sessionId = z.string().min(1).max(200);
export const PreviewOpenSchema = z
  .object({
    session_id: sessionId,
    client_id: z.string().uuid().optional(),
    kind: z.enum(["url", "file"]),
    target: z.string().min(1).max(8192),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.kind === "url" && !previewWebUrl(input.target))
      context.addIssue({
        code: "custom",
        message: "Use an HTTP/HTTPS URL without embedded credentials",
        path: ["target"],
      });
    if (
      input.kind === "file" &&
      (input.target.length > 4096 || [...input.target].some((char) => char.charCodeAt(0) < 32))
    )
      context.addIssue({ code: "custom", message: "Invalid file path", path: ["target"] });
  });
export type PreviewOpen = z.infer<typeof PreviewOpenSchema>;
export const BrowserActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("snapshot") }).strict(),
  z.object({ action: z.literal("screenshot") }).strict(),
  z.object({ action: z.literal("click"), selector: z.string().min(1).max(1000) }).strict(),
  z
    .object({
      action: z.literal("type"),
      selector: z.string().min(1).max(1000),
      text: z.string().max(10000),
    })
    .strict(),
  z
    .object({
      action: z.literal("press"),
      key: z.enum([
        "Enter",
        "Tab",
        "Escape",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Backspace",
        "Space",
      ]),
    })
    .strict(),
  z
    .object({
      action: z.literal("scroll"),
      x: z.number().finite().min(-10000).max(10000).default(0),
      y: z.number().finite().min(-10000).max(10000),
    })
    .strict(),
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;
export const PreviewBrowserInputSchema = z
  .object({
    session_id: sessionId,
    client_id: z.string().uuid().optional(),
    command: BrowserActionSchema,
  })
  .strict();
export type PreviewBrowserInput = z.infer<typeof PreviewBrowserInputSchema>;
export type PreviewOperation =
  | PreviewOpen
  | (PreviewBrowserInput & { kind: "browser"; target: string });
export const PreviewClientSchema = z
  .object({
    client_id: z.string().uuid(),
    session_id: sessionId.nullable(),
    agent_access: z.boolean().default(false),
  })
  .strict();
export type PreviewRequest = PreviewOperation & {
  id: string;
  client_id: string;
  status: "queued" | "opened" | "completed" | "failed" | "expired";
  error: string | null;
  result?: unknown;
  expires_at: number;
};
export interface PreviewFile {
  kind: "text" | "image";
  path: string;
  root: string;
  host: string | null;
  content: string;
  editable: boolean;
  local_token?: string;
}
export interface PreviewBrowserState {
  session_id: string;
  url: string;
  back: boolean;
  forward: boolean;
  loading: boolean;
  error: string | null;
}
export const PreviewBoundsSchema = z
  .object({
    x: z.number().finite().min(0).max(20000),
    y: z.number().finite().min(0).max(20000),
    width: z.number().finite().min(0).max(20000),
    height: z.number().finite().min(0).max(20000),
  })
  .strict();
export const PREVIEW_COMMAND = "orc:preview-command";
export const PREVIEW_EVENT = "orc:preview-event";
export const PREVIEW_OPEN_EVENT = "orc:preview-open";
export const PREVIEW_SETTINGS_EVENT = "orc:preview-settings";
export const PreviewPreferencesSchema = z
  .object({
    agentBrowserControl: z.boolean().default(true),
    openLinksIn: z.enum(["preview", "system"]).default("preview"),
  })
  .strict();
export type PreviewPreferences = z.infer<typeof PreviewPreferencesSchema>;

/** Parse chat destinations without treating Windows drive letters as URI protocols. */
export function previewLink(
  value: string,
): { kind: "url" | "file"; target: string; line?: number } | null {
  const web = previewWebUrl(value);
  if (web) return { kind: "url", target: web };
  if (
    !value ||
    value.startsWith("#") ||
    (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value) && !/^file:/i.test(value))
  )
    return null;
  let target = value;
  let line: number | undefined;
  const hash = /#L?(\d+)(?:C\d+)?(?:-L?\d+)?$/i.exec(target);
  if (hash) {
    line = Number(hash[1]);
    target = target.slice(0, hash.index);
  }
  const fragment = target.indexOf("#");
  if (fragment >= 0) target = target.slice(0, fragment);
  const suffix = /:(\d+)(?::\d+)?$/.exec(target);
  if (suffix) {
    line = Number(suffix[1]);
    target = target.slice(0, suffix.index);
  }
  try {
    target = decodeURIComponent(target);
  } catch {
    return null;
  }
  if (target.includes("\0")) return null;
  return { kind: "file", target, ...(line ? { line } : {}) };
}
