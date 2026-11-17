import { expect, test } from "bun:test";
import {
  appendDraftQuote,
  boundedText,
  closestTestId,
  isSelectionToolbarZone,
  MESSAGE_ACTION_LIMIT,
  markdownSelection,
  normalizeSelectionText,
  quoteBlock,
  quoteDraft,
  SELECTION_CAPTURE_LIMIT,
  type SelectionSource,
  type SelectionZoneNode,
  selectionAttribution,
  selectionTitle,
  taskBody,
} from "../../src/lib/chat-selection";

const source: SelectionSource = {
  threadId: "10000000-0000-4000-8000-000000000001",
  title: "Fix login",
  agent: "Codex",
  timestamp: 0,
};

function node(
  overrides: Partial<SelectionZoneNode> = {},
  parent: SelectionZoneNode | null = null,
): SelectionZoneNode {
  return {
    tagName: "DIV",
    isContentEditable: false,
    parentElement: parent,
    getAttribute: () => null,
    ...overrides,
  };
}

test("should normalize a selection and quote every line", () => {
  const raw = "  first  \nsecond\t\n\n\nthird   ";
  expect(normalizeSelectionText(raw)).toBe("  first\nsecond\n\nthird");
  expect(quoteBlock(raw)).toBe(">   first\n> second\n>\n> third");
  // Internal blank lines become a bare marker, not a trailing space.
  expect(quoteBlock("alpha\n\nbeta")).toBe("> alpha\n>\n> beta");
});

test("should cap a long selection with an ellipsis", () => {
  const capped = boundedText("word ".repeat(1200), SELECTION_CAPTURE_LIMIT);
  expect(capped.length).toBeLessThanOrEqual(SELECTION_CAPTURE_LIMIT);
  expect(capped.endsWith("…")).toBe(true);
  expect(capped.startsWith("> ")).toBe(false);
  expect(quoteBlock("word ".repeat(1200)).startsWith("> word word")).toBe(true);
});

test("should build one attribution wording for quote, copy and task", () => {
  expect(selectionAttribution(source, "quote", "9:41 AM")).toBe(
    "Source: Fix login · Codex · 9:41 AM",
  );
  expect(selectionAttribution(source, "copy", "9:41 AM")).toBe(
    "Source: Fix login · Codex · 9:41 AM",
  );
  expect(selectionAttribution(source, "task", "9:41 AM")).toBe(
    "Session: [Fix login](/tasks?chat=full&chatThread=10000000-0000-4000-8000-000000000001) · Codex · 9:41 AM",
  );
  // A missing session still links to chat instead of inventing an id.
  expect(selectionAttribution({ ...source, threadId: undefined }, "task", "9:41 AM")).toBe(
    "Session: [Fix login](/tasks?chat=full) · Codex · 9:41 AM",
  );
  // Link labels cannot break the Markdown link.
  expect(selectionAttribution({ ...source, title: "Fix [login]" }, "task", "9:41 AM")).toContain(
    "Session: [Fix \\[login\\]](",
  );
});

test("should produce the same quoted block for drafts and Markdown copying", () => {
  const expected = "> first line\n> second line\n>\n> last\n\nSource: Fix login · Codex · 9:41 AM";
  expect(quoteDraft("first line \nsecond line\n\nlast", source, 4000, "9:41 AM")).toBe(expected);
  expect(markdownSelection("first line \nsecond line\n\nlast", source, 4000, "9:41 AM")).toBe(
    expected,
  );
  expect(taskBody("first line \nsecond line\n\nlast", source, 4000, "9:41 AM")).toBe(
    "> first line\n> second line\n>\n> last\n\nSession: [Fix login](/tasks?chat=full&chatThread=10000000-0000-4000-8000-000000000001) · Codex · 9:41 AM",
  );
});

test("should derive a short title from the first line", () => {
  expect(selectionTitle("  Fix the   login flow  \nsecond line")).toBe("Fix the login flow");
  expect(selectionTitle(`\n\n   \n`)).toBe("Chat selection");
  const long = selectionTitle("a".repeat(120));
  expect(long.length).toBe(80);
  expect(long.endsWith("…")).toBe(true);
});

test("should bound the whole-message fallback", () => {
  const whole = boundedText("x".repeat(2500), MESSAGE_ACTION_LIMIT);
  expect(whole.length).toBe(MESSAGE_ACTION_LIMIT);
  expect(whole.endsWith("…")).toBe(true);
});

test("should separate an inserted quote from existing draft text", () => {
  expect(appendDraftQuote("hello", "> quote")).toBe("hello\n\n> quote");
  expect(appendDraftQuote("hello\n\n", "> quote")).toBe("hello\n\n> quote");
  expect(appendDraftQuote("", "> quote")).toBe("> quote");
  expect(appendDraftQuote("   ", "> quote")).toBe("> quote");
});

test("should keep the toolbar out of text fields and the terminal text layer", () => {
  const terminal = node({
    getAttribute: (name) => (name === "data-testid" ? "terminal-text-layer" : null),
  });
  const inner = node({}, terminal);
  expect(isSelectionToolbarZone(inner)).toBe(true);
  expect(isSelectionToolbarZone(node({ tagName: "textarea" }))).toBe(true);
  expect(isSelectionToolbarZone(node({ tagName: "input" }))).toBe(true);
  expect(isSelectionToolbarZone(node({ isContentEditable: true }))).toBe(true);
  expect(
    isSelectionToolbarZone(node({ getAttribute: (name) => (name === "role" ? "textbox" : null) })),
  ).toBe(true);
  expect(isSelectionToolbarZone(node())).toBe(false);
  expect(isSelectionToolbarZone(null)).toBe(false);
});

test("should find the message that owns a selection node", () => {
  const message = node({
    tagName: "DIV",
    getAttribute: (name) => (name === "data-testid" ? "chat-message" : null),
  });
  const inner = node({}, node({ tagName: "P" }, message));
  expect(closestTestId(inner, "chat-message")).toBe(message);
  expect(closestTestId(inner, "terminal-text-layer")).toBe(null);
});
