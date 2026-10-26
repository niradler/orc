/** Escapes text for Telegram HTML parse mode. Slice raw text before escaping, never after. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
