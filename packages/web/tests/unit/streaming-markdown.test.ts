import { expect, test } from "bun:test";
import { splitStreamingMarkdown } from "../../src/lib/streaming-markdown";

test("should keep a fenced code block whole", () => {
  const text = "Before the block.\n\n```ts\nconst value = 1;\n\nconsole.log(value);\n```\n\nAfter.";
  const blocks = splitStreamingMarkdown(text);
  expect(blocks).toHaveLength(3);
  expect(blocks[1]).toBe("```ts\nconst value = 1;\n\nconsole.log(value);\n```\n\n");
  // Nothing is dropped or reordered: the blocks are the input.
  expect(blocks.join("")).toBe(text);
});

test("should keep an ordered list with blank lines together", () => {
  const text = "1. First step\n\n2. Second step\n\n3. Third step";
  expect(splitStreamingMarkdown(text)).toEqual([
    "1. First step\n\n2. Second step\n\n3. Third step",
  ]);
});

test("should keep display math whole", () => {
  const text = "Inline idea.\n\n$$\nE = mc^2\n\nF = ma\n$$\n\nTail.";
  const blocks = splitStreamingMarkdown(text);
  expect(blocks).toHaveLength(3);
  expect(blocks[1]).toBe("$$\nE = mc^2\n\nF = ma\n$$\n\n");
});

test("should keep a settled prefix stable while the tail grows", () => {
  const start = "First paragraph.\n\nSecond paragraph";
  const grown = `${start} keeps growing`;
  const before = splitStreamingMarkdown(start);
  const after = splitStreamingMarkdown(grown);
  expect(before).toEqual(["First paragraph.\n\n", "Second paragraph"]);
  // The two arrays differ only in the last block, so its siblings do not re-render.
  expect(after).toEqual([before[0], "Second paragraph keeps growing"]);
});

test("should render one block for a one-line answer and nothing for blank input", () => {
  expect(splitStreamingMarkdown("One line")).toEqual(["One line"]);
  expect(splitStreamingMarkdown("")).toEqual([]);
  expect(splitStreamingMarkdown("  \n\n\t")).toEqual([]);
});

test("should keep an unfinished fence with the paragraph before it", () => {
  const text = "Intro.\n\n```ts\nconst open = true;";
  const blocks = splitStreamingMarkdown(text);
  expect(blocks).toEqual(["Intro.\n\n", "```ts\nconst open = true;"]);
  expect(blocks.join("")).toBe(text);
});
