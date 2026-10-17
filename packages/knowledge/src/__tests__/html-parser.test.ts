import { describe, expect, test } from "bun:test";
import { htmlTitle, htmlToMarkdown } from "../parsers/basic.js";

const page = (head: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8">${head}<link rel="stylesheet" href="a.css"></head><body>${body}</body></html>`;

describe("HTML conversion", () => {
  test("head metadata never becomes body text", async () => {
    const md = await htmlToMarkdown(
      page("<title>Release notes &amp; fixes</title>", "<h1>Release 2.0</h1><p>Body text.</p>"),
    );
    expect(md).not.toContain("Release notes");
    expect(md.trimStart().startsWith("# Release 2.0")).toBe(true);
    expect(md).toContain("Body text.");
  });

  test("a page titled only by <title> starts with that title as its heading", async () => {
    const md = await htmlToMarkdown(
      page("<title>  Onboarding\n guide </title>", "<h2>Day one</h2><p>Hello.</p>"),
    );
    expect(md.startsWith("# Onboarding guide\n\n")).toBe(true);
    expect(md.match(/Onboarding guide/g)).toHaveLength(1);
    expect(md).toContain("## Day one");
  });

  test("fragments without a head convert unchanged", async () => {
    expect(await htmlToMarkdown("<p>Just text</p>")).toBe("Just text");
  });

  test("the document title is the first H1, else the <title>, else none", () => {
    expect(
      htmlTitle(page("<title>Tab</title>", "<h1>Main <em>heading</em></h1><h1>Second</h1>")),
    ).toBe("Main heading");
    expect(htmlTitle(page("<title>Caf&#233; &amp; bar</title>", "<p>x</p>"))).toBe("Café & bar");
    expect(htmlTitle(page("<title> </title>", "<p>x</p>"))).toBeUndefined();
    expect(htmlTitle("<p>x</p>")).toBeUndefined();
  });
});
