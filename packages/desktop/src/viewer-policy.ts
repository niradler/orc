export const VIEWER_CHANNEL = "orc:viewer";
export const VIEWER_STATE_CHANNEL = "orc:viewer-state";
export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export type ViewerAction =
  | "navigate"
  | "back"
  | "forward"
  | "reload"
  | "external"
  | "file"
  | "browser";
export interface ViewerState {
  mode: "browser" | "file" | "image";
  url: string;
  back: boolean;
  forward: boolean;
  loading: boolean;
  error: string;
  file: { name: string; content: string } | null;
  image: { name: string; url: string } | null;
}

export function browserUrl(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 8192 ||
    [...value].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  )
    return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function decodeText(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_TEXT_BYTES) throw new Error("Choose a text file smaller than 1 MiB.");
  if (bytes.some((byte) => byte === 0 || (byte < 32 && ![9, 10, 12, 13, 27].includes(byte))))
    throw new Error("Binary files are not supported. Choose Markdown, code or plain text.");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("This viewer supports UTF-8 text files only.");
  }
}
