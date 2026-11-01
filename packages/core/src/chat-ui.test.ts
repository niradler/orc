import { describe, expect, test } from "bun:test";
import { CHAT_UI_FENCE, chatUiCatalogText, parseChatUiSpec } from "./chat-ui";

const parse = (spec: unknown) => parseChatUiSpec(JSON.stringify(spec));

describe("parseChatUiSpec", () => {
  test("should reject malformed elements, cycles, missing children and executable watchers", () => {
    for (const element of [
      null,
      1,
      { type: "Stack", children: ["a"] },
      { type: "Stack", children: ["missing"] },
      {
        type: "Text",
        props: { text: "x" },
        watch: { "/x": { action: "task.comment", params: { id: "t", content: "automatic" } } },
      },
      {
        type: "Text",
        props: { text: "x" },
        on: { press: { action: "task.update", params: { id: "t" } } },
      },
    ])
      expect(parse({ root: "a", elements: { a: element } }).ok).toBe(false);
  });

  test("should bound expanded layouts even when element definitions are shared", () => {
    const elements: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++)
      elements[String(i)] = {
        type: "Stack",
        children: i < 9 ? [String(i + 1), String(i + 1)] : [],
      };
    expect(parse({ root: "0", elements }).ok).toBe(false);
  });
  test("accepts leaf elements without props or children", () => {
    const result = parse({
      root: "main",
      elements: {
        main: { type: "Stack", children: ["task", "done"] },
        task: { type: "Task", props: { id: "t1" } },
        done: {
          type: "Button",
          props: { label: "Done" },
          on: { press: { action: "task.update", params: { id: "t1", status: "done" } } },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.elements.task?.children).toEqual([]);
  });

  test("rejects malformed JSON and non-spec values", () => {
    expect(parseChatUiSpec('{"root": "broken"')).toMatchObject({ ok: false });
    expect(parse([1, 2])).toMatchObject({ ok: false });
    expect(parse({ root: "a" })).toMatchObject({ ok: false });
  });

  test("rejects unknown components and invalid props", () => {
    expect(
      parse({ root: "a", elements: { a: { type: "Task", props: { id: "../../jobs/x" } } } }).ok,
    ).toBe(false);
    expect(parse({ root: "a", elements: { a: { type: "Nope" } } })).toMatchObject({ ok: false });
    expect(parse({ root: "a", elements: { a: { type: "Task", props: {} } } })).toMatchObject({
      ok: false,
    });
  });

  test("rejects script and protocol-relative links", () => {
    for (const href of [
      "javascript:alert(1)",
      "//evil.example",
      "data:text/html,x",
      "/\\evil.example",
      "/\t/evil.example",
    ])
      expect(
        parse({ root: "a", elements: { a: { type: "Link", props: { label: "x", href } } } }),
      ).toMatchObject({ ok: false });
    expect(
      parse({
        root: "a",
        elements: { a: { type: "Link", props: { label: "x", href: "/tasks/1" } } },
      }),
    ).toMatchObject({ ok: true });
  });

  test("rejects unknown actions and invalid static params", () => {
    const button = (on: unknown) => ({
      root: "a",
      elements: { a: { type: "Button", props: { label: "x" }, on } },
    });
    expect(parse(button({ press: { action: "rm" } }))).toMatchObject({
      ok: false,
      error: "Unknown action: rm",
    });
    expect(
      parse(button({ press: { action: "task.update", params: { id: "t", status: "nope" } } })),
    ).toMatchObject({ ok: false });
    expect(
      parse(button({ press: { action: "task.update", params: { id: { $state: "/id" } } } })),
    ).toMatchObject({ ok: true });
  });

  test("drops spec-level confirm so ORC owns confirmation", () => {
    const result = parse({
      root: "a",
      elements: {
        a: {
          type: "Button",
          props: { label: "Delete" },
          on: {
            press: {
              action: "task.delete",
              params: { id: "t" },
              confirm: { title: "x", message: "y" },
            },
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.spec.elements.a?.on?.press).toEqual({
        action: "task.delete",
        params: { id: "t" },
      });
  });

  test("rejects a root that does not exist", () => {
    expect(parse({ root: "x", elements: { a: { type: "Divider" } } })).toMatchObject({ ok: false });
  });
});

describe("chatUiCatalogText", () => {
  test("documents every component, action and the webchat-only rule", () => {
    const text = chatUiCatalogText();
    expect(text).toContain(`\`\`\`${CHAT_UI_FENCE}`);
    expect(text).toContain("webchat");
    for (const name of ["Task {", "TaskList {", "Job {", "Table {", "task.update {", "job.run {"])
      expect(text).toContain(name);
    expect(text).toContain("href?: string");
  });
});
