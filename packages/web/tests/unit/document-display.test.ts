import { expect, test } from "bun:test";
import { splitMarkdownFrontmatter } from "../../src/lib/document-display";

test("should separate only leading complete frontmatter from the rendered Markdown body", () => {
  expect(splitMarkdownFrontmatter("---\r\nname: skill\r\n---\r\n# Body")).toEqual({
    body: "# Body",
    metadata: "name: skill",
  });
  expect(splitMarkdownFrontmatter("\uFEFF---\nname: skill\n...\n# Body").body).toBe("# Body");
  for (const content of ["# Body\n---\nNot metadata", "---\nUnclosed metadata", "Plain Markdown"])
    expect(splitMarkdownFrontmatter(content)).toEqual({ body: content, metadata: null });
});
