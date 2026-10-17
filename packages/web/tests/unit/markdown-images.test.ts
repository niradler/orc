import { describe, expect, test } from "bun:test";
import { imageRendering } from "../../src/lib/markdown-images";

describe("imageRendering", () => {
  test("remote images become links instead of requests", () => {
    expect(imageRendering("https://tracker.example/p.gif?u=1")).toEqual({
      kind: "link",
      href: "https://tracker.example/p.gif?u=1",
    });
    expect(imageRendering("http://example.com/a.png")).toEqual({
      kind: "link",
      href: "http://example.com/a.png",
    });
    expect(imageRendering("//cdn.example/a.png")).toEqual({
      kind: "link",
      href: "https://cdn.example/a.png",
    });
  });

  test("embedded images render inline", () => {
    expect(imageRendering("data:image/png;base64,AAAA")).toEqual({
      kind: "inline",
      src: "data:image/png;base64,AAAA",
    });
    expect(imageRendering("blob:http://localhost/x")).toMatchObject({ kind: "inline" });
  });

  test("other sources show only the alt text", () => {
    expect(imageRendering("javascript:alert(1)")).toEqual({ kind: "text" });
    expect(imageRendering("data:text/html,<b>x</b>")).toEqual({ kind: "text" });
    expect(imageRendering("images/diagram.png")).toEqual({ kind: "text" });
    expect(imageRendering(undefined)).toEqual({ kind: "text" });
    expect(imageRendering("  ")).toEqual({ kind: "text" });
  });
});
