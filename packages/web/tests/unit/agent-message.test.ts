import { describe, expect, test } from "bun:test";
import { splitAgentMessage, splitUiBlocks } from "../../src/lib/agent-message";

describe("orc-ui blocks", () => {
  test("should leave quoted component examples inside an outer code fence inert", () => {
    const source = "````markdown\n```orc-ui\n{}\n```\n````";
    expect(splitUiBlocks(source)).toEqual([{ kind: "text", text: source, offset: 0 }]);
    expect(splitUiBlocks("```orc-ui\r\n{}\r\n```\r\n")[0]).toMatchObject({
      kind: "ui",
      source: "{}\r\n",
      complete: true,
    });
  });
  test("splits complete fences from surrounding text", () => {
    const source = 'Here:\n```orc-ui\n{"root":"a"}\n```\nDone';
    expect(splitUiBlocks(source)).toEqual([
      { kind: "text", text: "Here:\n", offset: 0 },
      { kind: "ui", source: '{"root":"a"}\n', complete: true, offset: 6 },
      { kind: "text", text: "\nDone", offset: source.indexOf("\nDone") },
    ]);
  });

  test("an unclosed fence is a spec still streaming", () => {
    expect(splitUiBlocks('```orc-ui\n{"root"')).toEqual([
      { kind: "ui", source: '{"root"', complete: false, offset: 0 },
    ]);
  });

  test("other fences and inline mentions stay text", () => {
    for (const source of ["```json\n{}\n```", "use ```orc-ui``` fences", "plain"])
      expect(splitUiBlocks(source)).toEqual([{ kind: "text", text: source, offset: 0 }]);
  });

  test("a longer closing fence closes and later blocks still split", () => {
    const parts = splitUiBlocks("````orc-ui\nA\n`````\n```orc-ui\nB\n```");
    expect(parts.map((part) => (part.kind === "ui" ? part.source : part.text))).toEqual([
      "A\n",
      "\n",
      "B\n",
    ]);
  });
});

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

  test("splits the orc-context block ORC prepends to a turn", () => {
    const source = "<orc-context>\nsource: webchat\nroute: /tasks\n</orc-context>\n\nshow my tasks";
    const parts = splitAgentMessage(source);
    expect(parts[0]).toMatchObject({ kind: "context", tag: "orc-context" });
    expect(parts[1]?.text).toBe("\n\nshow my tasks");
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
