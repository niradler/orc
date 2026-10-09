import { expect, test } from "bun:test";
import { remarkWikiLinks } from "../../src/lib/wiki-links";

test("wiki links transform prose but preserve code and existing link labels", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [{ type: "text", value: "See [[queue-order]] and [[missing]]." }],
      },
      { type: "inlineCode", value: "[[queue-order]]" },
      { type: "code", value: "[[queue-order]]" },
      {
        type: "link",
        url: "https://example.com",
        children: [{ type: "text", value: "[[queue-order]]" }],
      },
    ],
  };
  remarkWikiLinks()(tree);
  expect(tree.children[0]?.children).toEqual([
    { type: "text", value: "See " },
    { type: "link", url: "#wiki-queue-order", children: [{ type: "text", value: "queue-order" }] },
    { type: "text", value: " and " },
    { type: "link", url: "#wiki-missing", children: [{ type: "text", value: "missing" }] },
    { type: "text", value: "." },
  ]);
  expect(tree.children[1]?.value).toBe("[[queue-order]]");
  expect(tree.children[2]?.value).toBe("[[queue-order]]");
  expect(tree.children[3]?.children?.[0]?.value).toBe("[[queue-order]]");
});
