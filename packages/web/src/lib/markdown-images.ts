/**
 * How a Markdown image is shown. Remote images are never fetched: loading one tells its host who
 * opened the document and when (a tracking pixel), so it becomes a link the reader may follow.
 * Images embedded in the document (data:, blob:) render inline because they make no request.
 */
export type ImageRendering =
  | { kind: "inline"; src: string }
  | { kind: "link"; href: string }
  | { kind: "text" };

export function imageRendering(src: unknown): ImageRendering {
  if (typeof src !== "string" || !src.trim()) return { kind: "text" };
  const value = src.trim();
  if (/^data:image\//i.test(value) || /^blob:/i.test(value)) return { kind: "inline", src: value };
  const absolute = value.startsWith("//") ? `https:${value}` : value;
  try {
    const url = new URL(absolute);
    if (url.protocol === "http:" || url.protocol === "https:")
      return { kind: "link", href: url.href };
  } catch {
    // A relative path has nothing to resolve against inside a knowledge base or chat.
  }
  return { kind: "text" };
}
