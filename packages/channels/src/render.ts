import type { ChannelMessage } from "@orc/core/channels";
import { Lexer, type Token, type Tokens } from "marked";

const escapeText = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const safeUrl = (text: string) => (/^https?:\/\//i.test(text) ? text : "");

function tokens(items: Token[], provider: string): string {
  const telegram = provider === "telegram";
  return items
    .map((item) => {
      const t = item as Tokens.Generic;
      const inner = () => (t.tokens ? tokens(t.tokens, provider) : escapeText(t.text ?? ""));
      switch (t.type) {
        case "strong":
          return telegram ? `<b>${inner()}</b>` : `*${inner()}*`;
        case "em":
          return telegram ? `<i>${inner()}</i>` : `_${inner()}_`;
        case "del":
          return telegram ? `<s>${inner()}</s>` : `~${inner()}~`;
        case "codespan":
          return telegram ? `<code>${escapeText(t.text)}</code>` : `\`${escapeText(t.text)}\``;
        case "code":
          return telegram
            ? `<pre>${escapeText(t.text)}</pre>\n`
            : `\`\`\`\n${escapeText(t.text)}\n\`\`\`\n`;
        case "link": {
          const url = safeUrl(t.href ?? "");
          return url
            ? telegram
              ? `<a href="${escapeText(url).replace(/"/g, "&quot;")}">${inner()}</a>`
              : `<${url.replace(/[<>|]/g, encodeURIComponent)}|${inner()}>`
            : inner();
        }
        case "heading":
          return telegram ? `<b>${inner()}</b>\n\n` : `*${inner()}*\n\n`;
        case "paragraph":
          return `${inner()}\n\n`;
        case "list":
          return (t.items as Tokens.ListItem[])
            .map(
              (entry, i) =>
                `${entry.task ? "" : t.ordered ? `${i + (t.start || 1)}. ` : "• "}${tokens(entry.tokens, provider).trim()}\n`,
            )
            .join("");
        case "list_item":
          return inner();
        case "blockquote":
          return telegram
            ? `<blockquote>${inner().trim()}</blockquote>\n`
            : `${inner()
                .trim()
                .split("\n")
                .map((line) => `&gt; ${line}`)
                .join("\n")}\n`;
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

export function renderMessage(
  provider: "telegram" | "slack",
  message: ChannelMessage,
): { payloads: Record<string, unknown>[]; warnings: string[] } {
  const limit = provider === "telegram" ? 4000 : message.links.length ? 3000 : 30000;
  let plain = message.format === "plain";
  const text =
    message.format === "plain"
      ? escapeText(message.text)
      : tokens(Lexer.lex(message.text, { gfm: true }), provider).trim();
  const warnings: string[] = [];
  if (provider === "slack" && message.links.some((link) => Array.from(link.label).length > 75))
    warnings.push(
      "Slack button labels shortened to 75 characters; link destinations are unchanged.",
    );
  let chunks = [text];
  if (text.length > limit) {
    plain = true;
    warnings.push("Long message delivered in plain-text chunks to preserve all content safely.");
    const chars = Array.from(message.text);
    chunks = [];
    for (let i = 0; i < chars.length; i += 500)
      chunks.push(escapeText(chars.slice(i, i + 500).join("")));
  }
  const payloads: Record<string, unknown>[] = chunks.map((chunk) =>
    provider === "telegram"
      ? { text: chunk, parse_mode: "HTML" }
      : {
          text: chunk,
          mrkdwn: !plain,
          unfurl_links: false,
          unfurl_media: false,
        },
  );
  const last = payloads[payloads.length - 1];
  if (last && message.links.length) {
    if (provider === "telegram")
      last.reply_markup = {
        inline_keyboard: message.links.map((link) => [{ text: link.label, url: link.url }]),
      };
    else
      last.blocks = [
        {
          type: "section",
          text: {
            type: plain ? "plain_text" : "mrkdwn",
            text: plain
              ? String(last.text).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
              : String(last.text),
          },
        },
        {
          type: "actions",
          elements: message.links.map((link, i) => ({
            type: "button",
            action_id: `link-${i}`,
            text: { type: "plain_text", text: Array.from(link.label).slice(0, 75).join("") },
            url: link.url,
          })),
        },
      ];
  }
  return { payloads, warnings };
}
