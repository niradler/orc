export const NOTIFY_CHANNEL = "orc:notify";
export const OPEN_CHANNEL = "orc:open";

export interface NotifyRequest {
  title: string;
  body: string;
  path: string;
  level: "needs-you" | "done";
}

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.slice(0, max) : null;

/** Renderer payloads are untrusted: only short text and an in-app path survive. */
export function parseNotifyRequest(value: unknown): NotifyRequest | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const title = text(record.title, 120);
  const body = text(record.body, 300);
  const { path, level } = record;
  if (!title || !body) return null;
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return null;
  if (path.length > 2048 || path.includes("\\")) return null;
  if (level !== "needs-you" && level !== "done") return null;
  return { title, body, path, level };
}

export function shouldNotifyNatively(window: {
  isFocused(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
}): boolean {
  return !window.isFocused() || window.isMinimized() || !window.isVisible();
}
