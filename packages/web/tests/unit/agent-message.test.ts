import { describe, expect, test } from "bun:test";
import { splitAgentMessage } from "../../src/lib/agent-message";

describe("agent context display", () => {
  test("splits custom wrappers without changing a single character", () => {
    const source =
      "Question\n<recommended_plugins> Here is **context** </recommended_plugins>\nAnswer\n<system-reminder>more</system-reminder>";
    const parts = splitAgentMessage(source);
    expect(parts.map((part) => part.text).join("")).toBe(source);
    expect(parts.filter((part) => part.kind === "context").map((part) => part.tag)).toEqual([
      "recommended_plugins",
      "system-reminder",
    ]);
    expect(parts[0].text).toBe("Question\n");
    expect(parts[2].text).toBe("\nAnswer\n");
  });

  test("keeps nested wrappers and attributes intact, including same-name nesting", () => {
    const source =
      '<instructions type="context">\n<tools>Read</tools>\n<instructions>Nested</instructions><instructions />\n</instructions>\nAfter';
    const parts = splitAgentMessage(source);
    expect(parts[0].kind).toBe("context");
    expect(parts[0].text).toBe(source.slice(0, source.indexOf("\nAfter")));
    expect(parts[1].text).toBe("\nAfter");
  });

  test("leaves fenced/indented code, inline examples, HTML and incomplete wrappers visible", () => {
    for (const source of [
      "```xml\n<context>code</context>\n```",
      "~~~~xml\n<context>code</context>\n~~~\n~~~~",
      "    <context>code</context>",
      "`<context>code</context>`",
      "Mention <context>inline example</context>.",
      "<div>HTML</div>",
      "<recommended_plugins>still streaming",
      "<context />",
    ]) {
      expect(splitAgentMessage(source)).toEqual([{ kind: "text", text: source, offset: 0 }]);
    }
  });

  test("ignores close tags in code fences and separates adjacent blocks", () => {
    const source =
      "<context>\n```xml\n</context>\n```\nStill inside\n</context><tools>Read</tools>";
    const parts = splitAgentMessage(source);
    expect(parts.map((part) => part.kind)).toEqual(["context", "context"]);
    expect(parts.map((part) => part.text).join("")).toBe(source);
    expect(parts[0].text).toContain("Still inside");
  });

  test("handles empty text and many completed context blocks", () => {
    expect(splitAgentMessage("")).toEqual([]);
    const source = "<context>data</context>\n".repeat(500);
    expect(splitAgentMessage(source).filter((part) => part.kind === "context")).toHaveLength(500);
    expect(
      splitAgentMessage(source)
        .map((part) => part.text)
        .join(""),
    ).toBe(source);
  });

  test("ignores literal tags in multiline code spans and closing-tag examples", () => {
    const example = "`example\n<context>keep code</context>\nend`";
    expect(splitAgentMessage(example)).toEqual([{ kind: "text", text: example, offset: 0 }]);
    const source =
      "<context>\nUse `</context>` or ``a ` </context>`` literally.\nStill context\n</context>";
    expect(splitAgentMessage(source)).toEqual([
      { kind: "context", tag: "context", text: source, offset: 0 },
    ]);
  });
});
