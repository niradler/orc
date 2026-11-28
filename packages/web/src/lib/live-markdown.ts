/** Pure helpers for the shared live-preview Markdown editor. */

export type TableModel = {
  headers: string[];
  rows: string[][];
  aligns: ("left" | "center" | "right")[];
};

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/** Reads a GFM table block; null when the lines are not a table with a separator row. */
export function parseTable(lines: string[]): TableModel | null {
  if (lines.length < 2) return null;
  const header = cells(lines[0] ?? "");
  const separator = cells(lines[1] ?? "");
  if (!separator.length || !separator.every((c) => /^:?-{2,}:?$/.test(c))) return null;
  const aligns = separator.map((c) =>
    c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left",
  );
  return {
    headers: header,
    aligns,
    rows: lines
      .slice(2)
      .map(cells)
      .filter((row) => row.some(Boolean)),
  };
}

/** Pasting rendered HTML keeps links, emphasis, lists, code and tables as Markdown. */
export function htmlToMarkdown(html: string): string {
  if (typeof document === "undefined") return html;
  const root = document.createElement("div");
  root.innerHTML = html;
  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof HTMLElement)) return "";
    const body = [...node.childNodes].map(inline).join("");
    switch (node.tagName.toLowerCase()) {
      case "strong":
      case "b":
        return body.trim() ? `**${body}**` : body;
      case "em":
      case "i":
        return body.trim() ? `*${body}*` : body;
      case "del":
      case "s":
        return body.trim() ? `~~${body}~~` : body;
      case "code":
        return node.closest("pre") ? body : `\`${body.replace(/`/g, "\\`")}\``;
      case "a": {
        const href = node.getAttribute("href");
        return href ? `[${body || href}](${href})` : body;
      }
      case "img": {
        const src = node.getAttribute("src");
        return src ? `![${node.getAttribute("alt") ?? ""}](${src})` : "";
      }
      case "br":
        return "\n";
      default:
        return body;
    }
  };
  const block = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").trim();
    if (!(node instanceof HTMLElement)) return "";
    const tag = node.tagName.toLowerCase();
    if (tag === "pre") {
      const code = node.textContent ?? "";
      const language = node.querySelector("code")?.className.match(/language-([\w-]+)/)?.[1] ?? "";
      return `\n\`\`\`${language}\n${code.replace(/\n$/, "")}\n\`\`\`\n`;
    }
    if (/^h[1-6]$/.test(tag)) return `\n${"#".repeat(Number(tag[1]))} ${inline(node).trim()}\n`;
    if (tag === "ul" || tag === "ol") {
      const ordered = tag === "ol";
      return `\n${[...node.children]
        .filter((child) => child.tagName.toLowerCase() === "li")
        .map((child, i) => {
          const task = child.querySelector('input[type="checkbox"]');
          const prefix = task
            ? `- [${task.hasAttribute("checked") ? "x" : " "}] `
            : ordered
              ? `${i + 1}. `
              : "- ";
          return prefix + [...child.childNodes].map(inline).join("").trim();
        })
        .join("\n")}\n`;
    }
    if (tag === "blockquote")
      return `\n${inline(node)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n`;
    if (tag === "hr") return "\n---\n";
    if (tag === "table") {
      const rows = [...node.querySelectorAll("tr")].map((tr) =>
        [...tr.querySelectorAll("th,td")].map((cell) => inline(cell).trim()),
      );
      if (!rows.length) return "";
      const width = Math.max(...rows.map((row) => row.length));
      const line = (row: string[]) =>
        `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
      return `\n${[line(rows[0] ?? []), `| ${Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n")}\n`;
    }
    if (tag === "p" || tag === "div") return `\n${inline(node).trim()}\n`;
    return inline(node);
  };
  return [...root.childNodes]
    .map(block)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Markdown for a new table, sized to the current line when it already looks like one. */
export function tableTemplate(columns = 3): string {
  const n = Math.max(2, Math.min(8, columns));
  return `| ${Array.from({ length: n }, (_, i) => `Column ${i + 1}`).join(" | ")} |\n| ${Array(n).fill("---").join(" | ")} |\n| ${Array(n).fill("").join(" | ")} |`;
}

export function calloutTemplate(): string {
  return "> [!note]\n> ";
}

/** Slash-menu entries, in menu order. */
export const SLASH_COMMANDS = [
  { id: "h1", label: "Heading 1", hint: "#" },
  { id: "h2", label: "Heading 2", hint: "##" },
  { id: "h3", label: "Heading 3", hint: "###" },
  { id: "bullet", label: "Bulleted list", hint: "-" },
  { id: "ordered", label: "Numbered list", hint: "1." },
  { id: "task", label: "Task list", hint: "[ ]" },
  { id: "quote", label: "Quote", hint: ">" },
  { id: "fence", label: "Code block", hint: "```" },
  { id: "table", label: "Table", hint: "|" },
  { id: "callout", label: "Callout", hint: ">" },
  { id: "divider", label: "Divider", hint: "---" },
  { id: "link", label: "Link", hint: "[]()" },
  { id: "image", label: "Image", hint: "![]()" },
  { id: "wiki", label: "Wiki link", hint: "[[]]" },
] as const;

export type SlashCommand = (typeof SLASH_COMMANDS)[number]["id"];

/** Prefixes each selected line, or starts a new one when the selection is empty. */
export function prefixLines(text: string, prefix: string | ((index: number) => string)): string {
  return text
    .split("\n")
    .map((line, i) => `${typeof prefix === "function" ? prefix(i) : prefix}${line}`)
    .join("\n");
}
