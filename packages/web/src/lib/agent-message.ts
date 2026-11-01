export type AgentMessagePart =
  | { kind: "text"; text: string; offset: number }
  | { kind: "context"; tag: string; text: string; offset: number };

// Ordinary HTML stays with the Markdown renderer. Agent wrappers are custom tags.
const HTML_TAGS = new Set(
  "a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr svg math".split(
    " ",
  ),
);

function maskCode(text: string): string {
  let fence: { char: string; size: number } | null = null;
  const masked = text
    .split("\n")
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (
          marker &&
          marker[1][0] === fence.char &&
          marker[1].length >= fence.size &&
          !marker[2].trim()
        )
          fence = null;
        return " ".repeat(line.length);
      }
      if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) {
        fence = { char: marker[1][0], size: marker[1].length };
        return " ".repeat(line.length);
      }
      return /^( {4}|\t)/.test(line) ? " ".repeat(line.length) : line;
    })
    .join("\n");
  // Code spans can cross lines and can contain literal closing tags. Pair exact
  // backtick lengths, without repeatedly scanning the rest of a long message.
  const runs = [...masked.matchAll(/`+/g)];
  const next = new Map<number, number>();
  const ends = runs.map(() => -1);
  for (let i = runs.length - 1; i >= 0; i--) {
    ends[i] = next.get(runs[i][0].length) ?? -1;
    next.set(runs[i][0].length, i);
  }
  const chunks: string[] = [];
  let start = 0;
  for (let i = 0; i < runs.length; i++) {
    const end = ends[i];
    if (end < 0) continue;
    const offset = runs[end].index + runs[end][0].length;
    chunks.push(masked.slice(start, runs[i].index));
    chunks.push(masked.slice(runs[i].index, offset).replace(/[^\n]/g, " "));
    start = offset;
    i = end;
  }
  chunks.push(masked.slice(start));
  return chunks.join("");
}

export type UiMessagePart =
  | { kind: "text"; text: string; offset: number }
  | { kind: "ui"; source: string; complete: boolean; offset: number };

/** Splits out ```orc-ui fences; an unclosed fence is a spec still streaming. */
export function splitUiBlocks(text: string): UiMessagePart[] {
  const parts: UiMessagePart[] = [];
  let start = 0;
  let fence: { char: string; size: number; ui: boolean; offset: number; body: number } | null =
    null;
  for (const line of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!line[0]) continue;
    const marker = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n?$/.exec(line[0]);
    if (!marker) continue;
    if (fence) {
      if (marker[1][0] !== fence.char || marker[1].length < fence.size || marker[2].trim())
        continue;
      if (fence.ui) {
        parts.push({
          kind: "ui",
          source: text.slice(fence.body, line.index),
          complete: true,
          offset: fence.offset,
        });
        start = line.index + line[0].replace(/\r?\n$/, "").length;
      }
      fence = null;
    } else {
      if (marker[1][0] === "`" && marker[2].includes("`")) continue;
      const ui = marker[2].trim() === "orc-ui";
      if (ui && line.index > start)
        parts.push({ kind: "text", text: text.slice(start, line.index), offset: start });
      fence = {
        char: marker[1][0],
        size: marker[1].length,
        ui,
        offset: line.index,
        body: line.index + line[0].length,
      };
    }
  }
  if (fence?.ui) {
    parts.push({
      kind: "ui",
      source: text.slice(fence.body),
      complete: false,
      offset: fence.offset,
    });
    return parts;
  }
  if (start < text.length) parts.push({ kind: "text", text: text.slice(start), offset: start });
  return parts;
}

/** Display-only split: keep exact bytes and never interpret context as HTML. */
export function splitAgentMessage(text: string): AgentMessagePart[] {
  const masked = maskCode(text);
  const tags = /<(\/?)([a-z][\w.-]*)(?:[ \t]+[^<>]*?)?[ \t]*>/gi;
  const parts: AgentMessagePart[] = [];
  let context: { tag: string; start: number; depth: number } | null = null;
  let start = 0;
  for (const match of masked.matchAll(tags)) {
    const offset = match.index;
    const closing = match[1] === "/";
    const tag = match[2];
    if (context) {
      if (tag !== context.tag || /\/\s*>$/.test(match[0])) continue;
      context.depth += closing ? -1 : 1;
      if (context.depth !== 0) continue;
      if (context.start > start)
        parts.push({ kind: "text", text: text.slice(start, context.start), offset: start });
      const end = offset + match[0].length;
      parts.push({
        kind: "context",
        tag,
        text: text.slice(context.start, end),
        offset: context.start,
      });
      start = end;
      context = null;
    } else if (!closing && !HTML_TAGS.has(tag.toLowerCase()) && !/\/\s*>$/.test(match[0])) {
      const prefix = masked.slice(
        Math.max(start, masked.lastIndexOf("\n", offset - 1) + 1),
        offset,
      );
      if (/^ {0,3}$/.test(prefix)) context = { tag, start: offset, depth: 1 };
    }
  }
  if (start < text.length) parts.push({ kind: "text", text: text.slice(start), offset: start });
  return parts;
}
