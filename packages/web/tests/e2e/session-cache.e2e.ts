import { expect, test } from "@playwright/test";
import { API_SECRET } from "./_helpers";

const session = {
  id: "cache-fixture",
  session_id: "native-cache-fixture",
  agent: "claude",
  name: "Cache usage",
  status: "idle",
  cwd: "/demo",
  project_id: null,
  task: null,
  handoff: null,
  tokens_used: 10000,
  tokens_estimated: false,
  last_activity_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
};

for (const width of [1440, 390])
  for (const theme of ["dark", "light"]) {
    test(`session cache follows current session UI at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      const now = Date.now();
      await page.clock.install({ time: now });
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        ({ secret, theme }) => {
          localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
          localStorage.setItem("orc_theme", theme);
        },
        { secret: API_SECRET, theme },
      );
      await page.route("**/api/sessions/live?**", (route) =>
        route.fulfill({ json: { sessions: [session] } }),
      );
      await page.route("**/api/sessions/live/cache-fixture/transcript?**", (route) =>
        route.fulfill({
          json: {
            total: 1,
            offset: 0,
            matches: [],
            turns: [
              {
                index: 0,
                role: "assistant",
                time: null,
                blocks: [{ type: "text", text: "A normal session message." }],
              },
            ],
          },
        }),
      );
      await page.route("**/api/sessions/live/cache-fixture/cache", (route) =>
        route.fulfill({
          json: {
            latest: {
              input_tokens: 1000,
              cached_input_tokens: 800,
              cache_write_tokens: 100,
              recorded_at: new Date(now).toISOString(),
              may_be_cold_after: new Date(now + 60_000).toISOString(),
            },
            totals: { input_tokens: 10000, cached_input_tokens: 8500, cache_write_tokens: 1200 },
            output_tokens: 700,
            requests: 12,
            timeline: Array.from({ length: 12 }, (_, index) => ({
              request: index + 1,
              recorded_at: new Date(now - (12 - index) * 10_000).toISOString(),
              context_tokens: index === 6 ? 200 : 300 + index * 60,
              cached_input_tokens: 250 + index * 50,
              output_tokens: 60,
            })),
            compactions: [
              {
                recorded_at: new Date(now - 60_000).toISOString(),
                pre_tokens: 448563,
                post_tokens: 41112,
              },
            ],
          },
        }),
      );
      await page.goto("/sessions?project=all&session=cache-fixture");
      const detail = page.getByTestId("live-session-detail");
      const cache = page.getByTestId("session-cache");
      const indicator = page.getByTestId("session-cache-indicator");
      await expect(indicator).toHaveText("1k context · 1 compact · 80% cached input");
      await expect(cache).not.toHaveAttribute("open");
      await indicator.press("Enter");
      await expect(cache).toContainText("Session total 11k over 12 requests");
      await expect(cache).toContainText("Uncached input");
      const chart = page.getByTestId("session-context-chart");
      await expect(chart.locator("figcaption")).toHaveText("ContextCompacted");
      await expect(chart.locator(".recharts-area-curve")).toBeVisible();
      await expect(chart.locator(".recharts-reference-line")).toHaveCount(1);
      await expect(cache.getByRole("listitem").first()).toHaveText(
        /Read from cache\s*8,500\s*79\.4%/,
      );
      await expect(chart).toContainText("449k → 41k");
      await expect(cache).not.toContainText(/Last request|448,563/);
      await expect(cache).not.toContainText("unavailable");
      await page.clock.fastForward(60_001);
      await expect(indicator).toContainText("Cache may need rebuilding");
      await expect(cache).toContainText("80% last reported");
      expect(await detail.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      for (const label of await cache.getByRole("listitem").locator(".truncate").all())
        expect(await label.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await indicator.blur();
      await cache.screenshot({ path: testInfo.outputPath(`session-cache-${width}-${theme}.png`) });
    });
  }

test("session cache omits missing timing and unsupported evidence", async ({ page }) => {
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.route("**/api/sessions/live?**", (route) =>
    route.fulfill({ json: { sessions: [session] } }),
  );
  await page.route("**/api/sessions/live/cache-fixture/transcript?**", (route) =>
    route.fulfill({ json: { total: 0, offset: 0, matches: [], turns: [] } }),
  );
  let hasUsage = true;
  await page.route("**/api/sessions/live/cache-fixture/cache", (route) =>
    route.fulfill({
      json: {
        latest: hasUsage
          ? {
              input_tokens: 1000,
              cached_input_tokens: 800,
              cache_write_tokens: null,
              recorded_at: null,
              may_be_cold_after: null,
            }
          : null,
        totals: null,
        output_tokens: null,
        requests: null,
        compactions: null,
        timeline: null,
      },
    }),
  );
  await page.goto("/sessions?project=all&session=cache-fixture");
  const cache = page.getByTestId("session-cache");
  await expect(cache).toContainText("80% cached input");
  await cache.locator("summary").click();
  await expect(cache).not.toContainText(
    /expiry|unavailable|rebuilding|written|Session total|Compacted/,
  );
  await expect(page.getByTestId("session-context-chart")).toHaveCount(0);
  hasUsage = false;
  await page.reload();
  await expect(page.getByTestId("live-session-detail")).toBeVisible();
  await expect(cache).toHaveCount(0);
});
