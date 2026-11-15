import { describe, expect, test } from "bun:test";
import { CHAT_UI_FENCE, chatUiCatalog, chatUiCatalogText, parseChatUiSpec } from "./chat-ui";

const parse = (spec: unknown) => parseChatUiSpec(JSON.stringify(spec));

const WAVE_2: Record<string, Record<string, unknown>> = {
  Metric: {
    label: "Open tasks",
    value: 12,
    unit: "tasks",
    hint: "+3 this week",
    trend: "up",
  },
  Progress: { value: 62, label: "Migration" },
  Table: {
    columns: ["Task", "Status"],
    rows: [
      ["Render components", "Doing"],
      ["Review chart", "Done"],
    ],
    caption: "Today",
  },
  Sparkline: { values: [1, 3, 2, 5, 4], label: "Builds" },
  Chart: {
    kind: "line",
    labels: ["Mon", "Tue", "Wed"],
    series: [{ name: "Runs", values: [2, 5, 3] }],
    title: "Runs",
  },
  KeyValue: { items: [{ label: "Host", value: "This ORC server" }], title: "Runtime" },
  Callout: { tone: "warn", text: "Cache may need rebuilding.", title: "Heads up" },
  Html: { html: "<p>Hello</p>", title: "Demo", height: "tall" },
  SessionUsage: { sessionId: "session_1" },
};

const single = (type: string, props: unknown) =>
  parse({ root: "a", elements: { a: { type, props } } });

describe("parseChatUiSpec", () => {
  test("should reject malformed elements, cycles, missing children and executable watchers", () => {
    for (const element of [
      null,
      1,
      { type: "Stack", children: ["a"] },
      { type: "Stack", children: ["missing"] },
      {
        type: "Stack",
        props: {},
        watch: { "/x": { action: "task.comment", params: { id: "t", content: "automatic" } } },
      },
      {
        type: "Stack",
        props: {},
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

  test("rejects presentation components that Markdown already provides", () => {
    for (const type of [
      "Grid",
      "Card",
      "Heading",
      "Text",
      "Markdown",
      "Badge",
      "Stat",
      "Alert",
      "Link",
      "Divider",
      "Code",
    ])
      expect(parse({ root: "a", elements: { a: { type, props: {} } } }).ok).toBe(false);
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

describe("wave 2 presentational components", () => {
  test("accepts every new component through the parser", () => {
    for (const [type, props] of Object.entries(WAVE_2))
      expect({ type, result: single(type, props).ok }).toEqual({ type, result: true });
  });

  test("accepts a layout that mixes the new components", () => {
    const keys = Object.keys(WAVE_2);
    const result = parse({
      root: "main",
      elements: {
        main: { type: "Stack", children: keys },
        ...Object.fromEntries(
          Object.entries(WAVE_2).map(([type, props]) => [type, { type, props }]),
        ),
      },
    });
    expect(result.ok).toBe(true);
  });

  test("rejects malformed metric, progress, sparkline, key-value and callout props", () => {
    expect(single("Metric", { label: "Open tasks" }).ok).toBe(false);
    expect(single("Metric", { label: "", value: 1 }).ok).toBe(false);
    expect(single("Metric", { label: "Open tasks", value: "x".repeat(25) }).ok).toBe(false);
    expect(single("Metric", { label: "Open tasks", value: 1, trend: "sideways" }).ok).toBe(false);
    expect(single("Progress", { value: 101 }).ok).toBe(false);
    expect(single("Progress", { value: -1 }).ok).toBe(false);
    expect(single("Progress", { value: 50.5 }).ok).toBe(false);
    expect(single("Progress", { value: 50, label: "x".repeat(81) }).ok).toBe(false);
    expect(single("Sparkline", { values: [1] }).ok).toBe(false);
    expect(single("Sparkline", { values: Array.from({ length: 61 }, (_, i) => i) }).ok).toBe(false);
    expect(single("Sparkline", { values: [1, "two"] }).ok).toBe(false);
    expect(single("KeyValue", { items: [] }).ok).toBe(false);
    expect(
      single("KeyValue", {
        items: Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, value: "v" })),
      }).ok,
    ).toBe(false);
    expect(single("Callout", { tone: "success", text: "Done" }).ok).toBe(false);
    expect(single("Callout", { tone: "info", text: "x".repeat(281) }).ok).toBe(false);
  });

  test("bounds tables to six columns and fifty rows with matching cells", () => {
    const ok = single("Table", WAVE_2.Table).ok;
    expect(ok).toBe(true);
    expect(
      single("Table", {
        columns: Array.from({ length: 7 }, (_, i) => `C${i}`),
        rows: [Array.from({ length: 7 }, () => "")],
      }).ok,
    ).toBe(false);
    expect(
      single("Table", {
        columns: ["A"],
        rows: Array.from({ length: 51 }, () => ["x"]),
      }).ok,
    ).toBe(false);
    expect(single("Table", { columns: ["A", "B"], rows: [["one cell"]] }).ok).toBe(false);
    expect(single("Table", { columns: ["x".repeat(41)], rows: [["x"]] }).ok).toBe(false);
  });

  test("rejects malformed chart series but allows an empty chart", () => {
    expect(single("Chart", WAVE_2.Chart).ok).toBe(true);
    expect(
      single("Chart", {
        labels: ["Mon", "Tue"],
        series: [{ name: "Runs", values: [1] }],
      }).ok,
    ).toBe(false);
    expect(
      single("Chart", {
        labels: ["Mon"],
        series: [
          { name: "Runs", values: [1] },
          { name: "Runs", values: [2] },
        ],
      }).ok,
    ).toBe(false);
    expect(
      single("Chart", {
        labels: ["Mon"],
        series: Array.from({ length: 5 }, (_, i) => ({ name: `S${i}`, values: [i] })),
      }).ok,
    ).toBe(false);
    expect(
      single("Chart", {
        labels: Array.from({ length: 25 }, (_, i) => `L${i}`),
        series: [{ name: "Runs", values: Array.from({ length: 25 }, (_, i) => i) }],
      }).ok,
    ).toBe(false);
    expect(single("Chart", { labels: ["Mon"], series: [{ name: "Runs", values: ["1"] }] }).ok).toBe(
      false,
    );
    // An empty series is how an agent says "no data yet"; the renderer shows an empty state.
    expect(single("Chart", { labels: [], series: [{ name: "Runs", values: [] }] }).ok).toBe(true);
  });

  test("bounds sandboxed html and session ids", () => {
    expect(single("Html", WAVE_2.Html).ok).toBe(true);
    expect(single("Html", { html: "<p>x</p>".repeat(3000) }).ok).toBe(false);
    expect(single("Html", { html: "" }).ok).toBe(false);
    expect(single("Html", { html: "<p>x</p>", height: "huge" }).ok).toBe(false);
    expect(single("SessionUsage", { sessionId: "../sessions/1" }).ok).toBe(false);
    expect(single("SessionUsage", {}).ok).toBe(false);
  });

  test("rejects a layout over the rendered element budget", () => {
    const children = Array.from({ length: 200 }, (_, i) => `n${i}`);
    const elements: Record<string, unknown> = {
      main: { type: "Stack", children },
      ...Object.fromEntries(children.map((key) => [key, { type: "Stack", children: [] }])),
    };
    expect(parse({ root: "main", elements })).toMatchObject({
      ok: false,
      error: "Spec exceeds 200 elements",
    });
  });
});

describe("chatUiCatalogText", () => {
  test("documents every component, action and the webchat-only rule", () => {
    const text = chatUiCatalogText();
    expect(text).toContain(`\`\`\`${CHAT_UI_FENCE}`);
    expect(text).toContain("webchat");
    for (const name of ["Task {", "TaskList {", "Job {", "Button {", "task.update {", "job.run {"])
      expect(text).toContain(name);
    for (const name of Object.keys(WAVE_2)) expect(text).toContain(`- ${name} {`);
    expect(text).toContain("Markdown");
    expect(text).not.toContain("- Stat ");
    expect(text).toContain("## Examples");
  });

  test("lean variant keeps every name but drops descriptions and examples", () => {
    const lean = chatUiCatalogText("lean");
    for (const name of ["Task {", "Scratchpad {", "Stack {", "task.update {", "job.setEnabled {"])
      expect(lean).toContain(name);
    for (const name of Object.keys(WAVE_2)) expect(lean).toContain(`- ${name} {`);
    expect(lean).not.toContain("## Examples");
    expect(lean.length).toBeLessThan(chatUiCatalogText().length / 2);
  });

  test("stays within the prompt budget", () => {
    // Wave 1 shipped lean 1239 / full 3612 characters; nine components added ~700/1816.
    // The lean catalog rides in every webchat system prompt, so growth stays bounded.
    const lean = chatUiCatalogText("lean").length;
    const full = chatUiCatalogText("full").length;
    expect(lean).toBeLessThanOrEqual(2_100);
    expect(full).toBeLessThanOrEqual(5_600);
  });

  test("keeps the seven existing components and their actions unchanged", () => {
    const { components, actions } = chatUiCatalog.data;
    expect(Object.keys(components).slice(0, 7)).toEqual([
      "Stack",
      "Button",
      "Task",
      "TaskList",
      "Job",
      "SessionList",
      "Scratchpad",
    ]);
    expect(components.Stack.props.safeParse({ direction: "horizontal", gap: "lg" }).success).toBe(
      true,
    );
    expect(components.Stack.props.safeParse({ direction: "diagonal" }).success).toBe(false);
    expect(components.Button.props.safeParse({ label: "Done", variant: "primary" }).success).toBe(
      true,
    );
    expect(components.TaskList.props.safeParse({ limit: 51 }).success).toBe(false);
    expect(Object.keys(actions)).toEqual([
      "task.update",
      "task.comment",
      "task.delete",
      "job.run",
      "job.setEnabled",
    ]);
  });
});
