import type { ChannelMessage } from "@orc/core/channels";
import { Lexer, type Token, type Tokens } from "marked";

export const escapeText = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const safeUrl = (text: string) => (/^https?:\/\//i.test(text) ? text : "");

export function plainChunks(text: string, limit: number): string[] {
  const chars = Array.from(text);
  const chunks: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = start;
    let length = 0;
    let line = start;
    let space = start;
    while (end < chars.length) {
      const char = chars[end] ?? "";
      const size = escapeText(char).length;
      if (length + size > limit) break;
      length += size;
      end++;
      if (char === "\n") line = end;
      if (/\s/u.test(char)) space = end;
    }
    if (end < chars.length) {
      const minimum = start + (end - start) / 2;
      if (line > minimum) end = line;
      else if (space > minimum) end = space;
    }
    chunks.push(escapeText(chars.slice(start, end).join("")));
    start = end;
  }
  return chunks;
}

export type MarkdownMarks = {
  strong(text: string): string;
  em(text: string): string;
  del(text: string): string;
  code(text: string): string;
  pre(text: string): string;
  link(url: string, text: string): string;
  heading(text: string): string;
  quote(text: string): string;
};

function tokens(items: Token[], marks: MarkdownMarks): string {
  return items
    .map((item) => {
      const t = item as Tokens.Generic;
      const inner = () => (t.tokens ? tokens(t.tokens, marks) : escapeText(t.text ?? ""));
      switch (t.type) {
        case "strong":
          return marks.strong(inner());
        case "em":
          return marks.em(inner());
        case "del":
          return marks.del(inner());
        case "codespan":
          return marks.code(escapeText(t.text));
        case "code":
          return marks.pre(escapeText(t.text));
        case "link": {
          const url = safeUrl(t.href ?? "");
          return url ? marks.link(url, inner()) : inner();
        }
        case "heading":
          return `${marks.heading(inner())}\n\n`;
        case "paragraph":
          return `${inner()}\n\n`;
        case "list":
          return (t.items as Tokens.ListItem[])
            .map(
              (entry, i) =>
                `${entry.task ? "" : t.ordered ? `${i + (t.start || 1)}. ` : "• "}${tokens(entry.tokens, marks).trim()}\n`,
            )
            .join("");
        case "list_item":
          return inner();
        case "blockquote":
          return marks.quote(inner().trim());
        case "br":
          return "\n";
        case "checkbox":
          return t.checked ? "☑ " : "☐ ";
        case "hr":
          return "—\n";
        case "space":
          return "\n";
        case "text":
        case "escape":
          return inner();
        default:
          return escapeText(t.raw ?? t.text ?? "");
      }
    })
    .join("");
}

export function renderText(
  message: ChannelMessage,
  marks: MarkdownMarks,
  limit: number,
): { chunks: string[]; plain: boolean; warnings: string[] } {
  const text =
    message.format === "plain"
      ? escapeText(message.text)
      : tokens(Lexer.lex(message.text, { gfm: true }), marks).trim();
  if (text.length <= limit)
    return { chunks: [text], plain: message.format === "plain", warnings: [] };
  return {
    chunks: plainChunks(message.text, limit),
    plain: true,
    warnings: ["Long message delivered in plain-text chunks to preserve all content safely."],
  };
}

export function previewTail(text: string, limit = 2800): string {
  const chars = Array.from(text).slice(-limit);
  let start = chars.length;
  let length = 0;
  while (start > 0) {
    const size = escapeText(chars[start - 1] ?? "").length;
    if (length + size > limit) break;
    length += size;
    start--;
  }
  return chars.slice(start).join("");
}
