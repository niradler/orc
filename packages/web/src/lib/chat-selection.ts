/**
 * Pure builders for acting on a chat selection. The toolbar, the message actions
 * menu and Copy as Markdown all use these so quoted text and the attribution
 * line read the same wherever the action starts.
 */

/** A floating toolbar over a long drag stays useful without copying megabytes. */
export const SELECTION_CAPTURE_LIMIT = 4000;
/** The actions menu acts on the whole message when nothing is selected. */
export const MESSAGE_ACTION_LIMIT = 2000;
export const SELECTION_TITLE_LIMIT = 80;

export type ChatSelectionAction = "ask" | "task" | "save";
export type AttributionForm = "quote" | "task" | "copy";

export interface SelectionSource {
  threadId?: string | undefined;
  /** The session title at the moment the action ran. */
  title: string;
  /** A human label, already resolved through `agentLabel`. */
  agent: string;
  /** Message timestamp in milliseconds. */
  timestamp: number;
}

/** The node shape needed to tell whether a selection belongs to a toolbar zone. */
export interface SelectionZoneNode {
  tagName?: string | undefined;
  isContentEditable?: boolean | undefined;
  parentElement?: SelectionZoneNode | null | undefined;
  getAttribute?(name: string): string | null;
}

const TEXT_FIELD_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Normalize a raw selection for quoting: unify line endings, drop trailing
 * whitespace on each line, remove leading/trailing blank lines and collapse
 * runs of blank lines. Leading indentation is kept.
 */
export function normalizeSelectionText(text: string): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""));
  while (lines.length > 0 && !lines[0]?.trim()) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1]?.trim()) lines.pop();
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Bound normalized text to `limit` characters, ending with an ellipsis when cut. */
export function boundedText(text: string, limit = SELECTION_CAPTURE_LIMIT): string {
  const normalized = normalizeSelectionText(text);
  if (normalized.length <= limit) return normalized;
  const capped = normalized.slice(0, Math.max(0, limit - 1)).trimEnd();
  return `${capped}…`;
}

/** Prefix every line with `> `; external blank lines become a bare `>`. */
export function quoteBlock(text: string, limit = SELECTION_CAPTURE_LIMIT): string {
  return boundedText(text, limit)
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

/** The viewer's locale, so a copied quote reads naturally where it was taken. */
export function formatSelectionTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

/** The in-app link back to the conversation a task or pad came from. */
export function sessionChatLink(threadId?: string): string {
  return threadId
    ? `/tasks?chat=full&chatThread=${encodeURIComponent(threadId)}`
    : "/tasks?chat=full";
}

function titleText(source: SelectionSource): string {
  return source.title.replace(/\s+/g, " ").trim() || "New chat";
}

function agentText(source: SelectionSource): string {
  return source.agent.replace(/\s+/g, " ").trim() || "Assistant";
}

/** Markdown-escape a title used inside a link label. */
function linkLabel(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

/**
 * One attribution builder for the three destinations: a quoted draft or copied
 * Markdown says `Source:`, and a task says `Session:` with a link back.
 */
export function selectionAttribution(
  source: SelectionSource,
  form: AttributionForm,
  time = formatSelectionTime(source.timestamp),
): string {
  const title = titleText(source);
  const agent = agentText(source);
  if (form === "task") {
    return `Session: [${linkLabel(title)}](${sessionChatLink(source.threadId)}) · ${agent} · ${time}`;
  }
  return `Source: ${title} · ${agent} · ${time}`;
}

function quoteWithAttribution(
  text: string,
  source: SelectionSource,
  form: AttributionForm,
  limit: number,
  time?: string,
): string {
  return `${quoteBlock(text, limit)}\n\n${selectionAttribution(source, form, time)}`;
}

/** The composer draft block for Ask about this. */
export function quoteDraft(
  text: string,
  source: SelectionSource,
  limit = SELECTION_CAPTURE_LIMIT,
  time?: string,
): string {
  return quoteWithAttribution(text, source, "quote", limit, time);
}

/** The task description: the quote plus a link back to this session. */
export function taskBody(
  text: string,
  source: SelectionSource,
  limit = SELECTION_CAPTURE_LIMIT,
  time?: string,
): string {
  return quoteWithAttribution(text, source, "task", limit, time);
}

/** Scratchpad content and Copy as Markdown share the quote form. */
export function markdownSelection(
  text: string,
  source: SelectionSource,
  limit = SELECTION_CAPTURE_LIMIT,
  time?: string,
): string {
  return quoteWithAttribution(text, source, "copy", limit, time);
}

/** Append a block to a draft, separated from existing text by one blank line. */
export function appendDraftQuote(existing: string, block: string): string {
  const prior = existing.trimEnd();
  return prior ? `${prior}\n\n${block}` : block;
}

/** A short task or pad title from the selection's first non-empty line. */
export function selectionTitle(text: string, limit = SELECTION_TITLE_LIMIT): string {
  const first = normalizeSelectionText(text)
    .split("\n")
    .find((line) => line.trim());
  const single = (first ?? "").replace(/\s+/g, " ").trim();
  if (!single) return "Chat selection";
  return single.length <= limit ? single : `${single.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * True when the selection starts in a field or in the terminal's own text layer,
 * so the chat selection toolbar never competes with them.
 */
export function isSelectionToolbarZone(node: SelectionZoneNode | null | undefined): boolean {
  for (let current = node; current; current = current.parentElement) {
    const tag = (current.tagName ?? "").toUpperCase();
    if (TEXT_FIELD_TAGS.has(tag) || current.isContentEditable) return true;
    if (current.getAttribute?.("data-testid") === "terminal-text-layer") return true;
    if (current.getAttribute?.("role") === "textbox") return true;
  }
  return false;
}

/** Walk up to the nearest element carrying `data-testid="<testId>"`. */
export function closestTestId(
  node: SelectionZoneNode | null | undefined,
  testId: string,
): SelectionZoneNode | null {
  for (let current = node; current; current = current.parentElement) {
    if (current.getAttribute?.("data-testid") === testId) return current;
  }
  return null;
}
