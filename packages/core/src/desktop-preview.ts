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
export const BrowserSelectorSchema = z.union([
  z.string().min(1).max(1000),
  z
    .object({
      by: z.enum(["role", "text", "label", "placeholder", "testid", "css"]),
      value: z.string().min(1).max(1000),
      name: z.string().max(1000).optional(),
      exact: z.boolean().optional(),
    })
    .strict(),
]);
export type BrowserSelector = z.infer<typeof BrowserSelectorSchema>;
export const BrowserActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("resize_reset") }).strict(),
  z.object({ action: z.literal("download"), download_id: z.string().uuid() }).strict(),
  z
    .object({
      action: z.literal("upload"),
      selector: BrowserSelectorSchema,
      paths: z.array(z.string().min(1).max(4096)).min(1).max(10),
    })
    .strict(),
  z.object({ action: z.literal("frames") }).strict(),
  z.object({ action: z.literal("frame"), frame_id: z.string().max(100).nullable() }).strict(),
  z
    .object({
      action: z.literal("dialog"),
      response: z.enum(["status", "accept", "dismiss"]).default("status"),
      text: z.string().max(2000).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("appearance"),
      color_scheme: z.enum(["light", "dark", "system"]),
      reduced_motion: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("resize"),
      width: z.number().int().min(240).max(3840),
      height: z.number().int().min(160).max(2160),
      device_scale_factor: z.number().min(0.5).max(4).default(1),
      mobile: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      action: z.literal("recording_start"),
      max_seconds: z.number().int().min(1).max(180).default(60),
    })
    .strict(),
  z.object({ action: z.literal("recording_stop") }).strict(),
  z.object({ action: z.literal("tabs") }).strict(),
  z.object({ action: z.literal("tab_select"), tab_id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("tab_close"), tab_id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("new_tab"), url: z.string().min(1).max(8192) }).strict(),
  z.object({ action: z.literal("navigate"), url: z.string().min(1).max(8192) }).strict(),
  z.object({ action: z.literal("back") }).strict(),
  z.object({ action: z.literal("forward") }).strict(),
  z.object({ action: z.literal("reload") }).strict(),
  z
    .object({
      action: z.literal("snapshot"),
      selector: BrowserSelectorSchema.optional(),
      max_chars: z.number().int().min(1000).max(24000).optional(),
    })
    .strict(),
  z.object({ action: z.literal("screenshot") }).strict(),
  z.object({ action: z.literal("click"), selector: BrowserSelectorSchema }).strict(),
  z.object({ action: z.literal("hover"), selector: BrowserSelectorSchema }).strict(),
  z
    .object({
      action: z.literal("select"),
      selector: BrowserSelectorSchema,
      values: z.array(z.string().max(1000)).max(100),
    })
    .strict(),
  z
    .object({
      action: z.literal("drag"),
      selector: BrowserSelectorSchema,
      target: BrowserSelectorSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("wait"),
      selector: BrowserSelectorSchema.optional(),
      text: z.string().min(1).max(4000).optional(),
      url_includes: z.string().min(1).max(8192).optional(),
      state: z.enum(["visible", "hidden", "attached", "detached"]).default("visible"),
      timeout_ms: z.number().int().min(1).max(10000).default(5000),
    })
    .strict()
    .refine((input) => input.selector || input.text || input.url_includes, {
      message: "Provide a selector, text or URL condition",
    }),
  z
    .object({
      action: z.literal("evaluate"),
      expression: z.string().min(1).max(20000),
      timeout_ms: z.number().int().min(1).max(10000).default(5000),
    })
    .strict(),
  z
    .object({
      action: z.literal("type"),
      selector: BrowserSelectorSchema,
      text: z.string().max(10000),
    })
    .strict(),
  z
    .object({
      action: z.literal("press"),
      modifiers: z
        .array(z.enum(["Control", "Alt", "Meta", "Shift"]))
        .max(4)
        .optional(),
      key: z.union([
        z.string().regex(/^[A-Za-z0-9]$/),
        z.enum([
          "Enter",
          "Tab",
          "Escape",
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "Backspace",
          "Space",
          "Delete",
          "Home",
          "End",
          "PageUp",
          "PageDown",
        ]),
      ]),
    })
    .strict(),
  z
    .object({
      action: z.literal("scroll"),
      selector: BrowserSelectorSchema.optional(),
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
    tab_id: z.string().uuid().optional(),
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
    browser_ready: z.boolean().default(false),
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
  downloads?: PreviewDownload[];
  session_id: string;
  url: string;
  back: boolean;
  forward: boolean;
  loading: boolean;
  error: string | null;
  dialog?: { type: string; message: string; default_prompt: string } | null;
  color_scheme?: "light" | "dark" | "system";
  recording?: boolean;
  recording_available?: boolean;
  tab_id?: string;
  profile_id?: string | null;
  tabs?: { tab_id: string; url: string; profile_id: string | null }[];
}
export interface PreviewDownload {
  id: string;
  name: string;
  status: "downloading" | "completed" | "failed";
  bytes: number;
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
export const PREVIEW_PROFILES_EVENT = "orc:preview-profiles";
export const PreviewPreferencesSchema = z
  .object({
    agentBrowserControl: z.boolean().default(true),
    openLinksIn: z.enum(["preview", "system"]).default("preview"),
  })
  .strict();
export type PreviewPreferences = z.infer<typeof PreviewPreferencesSchema>;
export const PreviewProfileSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    origin: z.string().url(),
  })
  .strict();
export type PreviewProfile = z.infer<typeof PreviewProfileSchema>;
export interface PreviewImportSource {
  id: string;
  name: string;
  sites: string[];
}
export interface PreviewImportResult {
  imported: number;
  skipped: number;
}

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
