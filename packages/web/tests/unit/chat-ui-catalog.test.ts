import { expect, test } from "bun:test";
import { HTML_POLICY, isolatedHtml } from "../../src/components/chat-ui/sandboxed-html";
import {
  chartRows,
  hasChartData,
  SERIES_COLORS,
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
    { label: "Mon", Chat: 4, Terminal: 2 },
    { label: "Tue", Chat: 7, Terminal: null },
  ]);
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
