import { expect, test } from "bun:test";
import { HTML_POLICY, isolatedHtml } from "../../src/components/chat-ui/sandboxed-html";
import {
  chartRows,
  chartSummary,
  hasChartData,
  SERIES_COLORS,
  sparklineDirection,
  sparklineRows,
  sparklineSummary,
} from "../../src/lib/chat-ui-chart";
import { contextUsageHelp } from "../../src/lib/session-cache";

test("chart rows pair every label with one value per series", () => {
  expect(
    chartRows(
      ["Mon", "Tue"],
      [
        { name: "Chat", values: [4, 7] },
        { name: "Terminal", values: [2] },
      ],
    ),
  ).toEqual([
    { label: "Mon", s0: 4, s1: 2 },
    { label: "Tue", s0: 7, s1: null },
  ]);
});

test("chart rows keep series keys positional so names cannot collide", () => {
  const rows = chartRows(
    ["Mon"],
    [
      { name: "label", values: [1] },
      { name: "__proto__", values: [2] },
    ],
  );
  expect(rows).toEqual([{ label: "Mon", s0: 1, s1: 2 }]);
  expect(Object.keys(rows[0] ?? {})).toEqual(["label", "s0", "s1"]);
});

test("a chart without points shows its empty state instead of a flat line", () => {
  expect(hasChartData([], [{ name: "Chat", values: [] }])).toBe(false);
  expect(hasChartData([], [{ name: "Chat", values: [1] }])).toBe(false);
  expect(hasChartData(["Mon"], [{ name: "Chat", values: [1] }])).toBe(true);
});

test("series colours come from the design tokens, never a literal", () => {
  expect(SERIES_COLORS).toHaveLength(4);
  for (const color of SERIES_COLORS) expect(color).toMatch(/^var\(--color-series-[1-4]\)$/);
});

test("sparkline summary states direction and range in text", () => {
  expect(sparklineSummary([3, 8, 2])).toEqual({
    first: 3,
    last: 2,
    min: 2,
    max: 8,
    direction: "down",
  });
  expect(sparklineSummary([1, 4])).toMatchObject({ direction: "up", last: 4 });
  expect(sparklineSummary([5, 5])).toMatchObject({ direction: "flat" });
  expect(sparklineRows([3, 8])).toEqual([
    { index: 0, value: 3 },
    { index: 1, value: 8 },
  ]);
});

test("a flat sparkline reads as no change instead of a range from itself", () => {
  expect(sparklineDirection(sparklineSummary([3, 8, 1]))).toBe("down from 3 to 1");
  expect(sparklineDirection(sparklineSummary([1, 4]))).toBe("up from 1 to 4");
  expect(sparklineDirection(sparklineSummary([5, 5]))).toBe("no change, 5");
  expect(sparklineDirection(sparklineSummary([1_200, 1_200]))).toBe("no change, 1,200");
});

test("chart summary states each series' first and last value", () => {
  expect(
    chartSummary({
      title: "Sessions",
      kind: "line",
      labels: ["Mon", "Fri"],
      series: [
        { name: "Chat", values: [4, 6] },
        { name: "Terminal", values: [2, 5] },
      ],
    }),
  ).toBe("Sessions: line chart. Chat 4 to 6. Terminal 2 to 5. labels Mon to Fri.");
  expect(
    chartSummary({ kind: "bar", labels: ["Mon"], series: [{ name: "Runs", values: [7] }] }),
  ).toBe("Chart: bar chart. Runs 7 to 7. labels Mon to Mon.");
});

test("inline HTML carries the sandbox policy before its own markup", () => {
  expect(isolatedHtml("<p>hi</p>")).toBe(
    `<meta http-equiv="Content-Security-Policy" content="${HTML_POLICY}"><p>hi</p>`,
  );
  expect(isolatedHtml("<!doctype html><p>hi</p>")).toBe(
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_POLICY}"><p>hi</p>`,
  );
  for (const directive of [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ])
    expect(HTML_POLICY).toContain(directive);
  expect(HTML_POLICY).not.toContain("allow-same-origin");
});

test("context usage copy states the tokens, the cached share and the omission rule", () => {
  const help = contextUsageHelp(120_000, 75, 1);
  expect(help.explanation).toContain("120k tokens (120,000)");
  expect(help.explanation).toContain("75% came from the provider's cache");
  expect(help.note).toContain("1 compaction has");
  expect(help.note).toContain("only when the agent records usage");
  expect(contextUsageHelp(1_000, 0, 0).note).toStartWith("Context compaction summarizes");
});
