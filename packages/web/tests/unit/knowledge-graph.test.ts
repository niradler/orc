import { expect, test } from "bun:test";
import type { WikiPage } from "@orc/sdk/types";
import { noteEdges, noteLinks } from "../../src/lib/knowledge-graph";

function note(slug: string, project_id: string | null, content: string): WikiPage {
  return {
    slug,
    project_id,
    content,
    title: slug,
    kind: "lesson",
    revision: 1,
    summary: slug,
    tags: [],
    sources: [],
    author: "human",
    updated_at: 1,
  };
}

test("connections ignore code examples and repeated links", () => {
  expect(noteLinks("[[real]] [[real]] `[[inline]]`\n```md\n[[example]]\n```\n[[second]]")).toEqual([
    "real",
    "second",
  ]);
});

test("unclosed and longer closing Markdown fences remain code, including CRLF documents", () => {
  expect(
    noteLinks("[[real]]\r\n~~~md\r\n[[example]]\r\n~~~~\r\n[[second]]\r\n```\r\n[[unfinished]]"),
  ).toEqual(["real", "second"]);
});

test("connections respect note ownership and global fallback without inventing missing targets", () => {
  const pages = [
    note("start", "p", "[[target]] [[shared]] [[missing]]"),
    note("target", "p", "[[start]]"),
    note("target", null, ""),
    note("shared", null, ""),
  ];
  expect(noteEdges(pages)).toEqual([
    { from: "p:start", to: "p:target" },
    { from: "p:start", to: "global:shared" },
    { from: "p:target", to: "p:start" },
  ]);
});

test("global fallback notes navigate the effective project notebook when a slug is overridden", () => {
  expect(noteEdges([note("shared", null, "[[decision]]"), note("decision", "p", "")])).toEqual([
    { from: "global:shared", to: "p:decision" },
  ]);
});
