import { expect, test } from "@playwright/test";
import { settingsSection } from "./_chat-ui";
import { API_SECRET } from "./_helpers";

const now = new Date().toISOString();
const emptyNumbers = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  other_tokens: 0,
  total_tokens: 0,
  requests: 0,
  sessions: 0,
  estimated_requests: 0,
};
const bucketSamples = [
  { input: 3_000, output: 1_000, cache: 8_000, requests: 4, sessions: 1 },
  { input: 4_000, output: 2_000, cache: 10_000, requests: 6, sessions: 2 },
  { input: 6_000, output: 3_000, cache: 15_000, requests: 8, sessions: 3 },
  { input: 5_000, output: 3_000, cache: 17_000, requests: 8, sessions: 3 },
  { input: 7_000, output: 4_000, cache: 20_000, requests: 10, sessions: 4 },
  { input: 5_000, output: 2_000, cache: 10_000, requests: 6, sessions: 2 },
];
const bucketAt = (granularity: string, index: number) => {
  const step = granularity === "hour" ? 3_600_000 : 86_400_000;
  const at = new Date(Date.now() - (bucketSamples.length - 1 - index) * step);
  return granularity === "hour"
    ? `${at.toISOString().slice(0, 13)}:00Z`
    : at.toISOString().slice(0, 10);
};
const bucketsFor = (granularity: string) =>
  bucketSamples.map((sample, index) => ({
    ...emptyNumbers,
    bucket: bucketAt(granularity, index),
    input_tokens: sample.input,
    output_tokens: sample.output,
    cache_read_tokens: sample.cache,
    requests: sample.requests,
    sessions: sample.sessions,
    total_tokens: sample.input + sample.output + sample.cache,
  }));
const report = {
  days: 30,
  since: now,
  granularity: "day",
  filters: { agent: null, model: null },
  totals: {
    ...emptyNumbers,
    input_tokens: 30_000,
    output_tokens: 15_000,
    cache_read_tokens: 80_000,
    requests: 42,
    sessions: 7,
    total_tokens: 125_000,
  },
  agents: [
    {
      ...emptyNumbers,
      agent: "codex",
      input_tokens: 30_000,
      output_tokens: 15_000,
      cache_read_tokens: 80_000,
      requests: 42,
      sessions: 7,
      total_tokens: 125_000,
    },
  ],
  models: [
    {
      ...emptyNumbers,
      agent: "codex",
      model: "gpt-6",
      input_tokens: 30_000,
      output_tokens: 10_000,
      cache_read_tokens: 60_000,
      requests: 30,
      sessions: 5,
      total_tokens: 100_000,
    },
    {
      ...emptyNumbers,
      agent: "codex",
      model: null,
      output_tokens: 5_000,
      cache_read_tokens: 20_000,
      requests: 12,
      sessions: 2,
      estimated_requests: 12,
      total_tokens: 25_000,
    },
  ],
  buckets: [],
  coverage: {
    indexed_sessions: 7,
    unindexed_sessions: 2,
    unindexed_tokens: 900,
    unknown_sessions: 1,
    estimated_sessions: 1,
  },
};
const quotas = {
  accounts: [
    {
      provider: "codex",
      status: "available",
      message: null,
      checked_at: now,
      windows: [
        { label: "5-hour window", used_percent: 35, resets_at: "2026-11-07T12:00:00.000Z" },
        { label: "7-day window", used_percent: 100, resets_at: null },
      ],
    },
    {
      provider: "claude",
      status: "signed_out",
      message: "No readable local account login.",
      checked_at: now,
      windows: [],
    },
  ],
};

for (const width of [1440, 390])
  for (const theme of ["dark", "light"]) {
    test(`usage report and quotas at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        ({ secret, theme }) => {
          localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
          localStorage.setItem("orc_theme", theme);
        },
        { secret: API_SECRET, theme },
      );
      await page.route("**/api/usage/report?*", async (route) => {
        const url = new URL(route.request().url());
        const granularity = url.searchParams.get("granularity") ?? "day";
        await route.fulfill({
          json: {
            ...report,
            days: Number(url.searchParams.get("days") ?? 30),
            granularity,
            filters: {
              agent: url.searchParams.get("agent"),
              model: url.searchParams.get("model"),
            },
            buckets: bucketsFor(granularity),
          },
        });
      });
      await page.route("**/api/usage/quotas", (route) => route.fulfill({ json: quotas }));
      await page.goto("/settings");
      await settingsSection(page, "usage");
      const section = page.getByTestId("settings-usage");
      await expect(section).toBeVisible();
      await expect(page.getByTestId("usage-total-tokens")).toHaveText("125k");
      await expect(page.getByTestId("usage-total-requests")).toHaveText("42");
      await expect(page.getByTestId("usage-total-sessions")).toHaveText("7");
      await expect(section).toContainText("Cache read");
      await expect(page.getByTestId("usage-chart")).toBeVisible();
      const modelRow = section.getByTestId("usage-model-row").first();
      await expect(modelRow).toContainText("gpt-6");
      await modelRow.click();
      await expect(modelRow).toHaveAttribute("aria-expanded", "true");
      await expect(section.getByTestId("usage-models")).toContainText("gpt-6");
      await expect(page.getByTestId("usage-quota-codex")).not.toBeVisible();
      await page.getByTestId("usage-quotas").locator("summary").click();
      const quota = page.getByTestId("usage-quota-codex");
      await expect(quota).toBeVisible();
      await expect(quota.getByRole("progressbar").first()).toHaveAttribute("aria-valuenow", "35");
      await expect(page.getByTestId("usage-quota-claude")).toContainText(
        "No readable local account login",
      );
      await page.setViewportSize({ width, height: width === 390 ? 2400 : 1600 });
      expect(await section.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await section.screenshot({ path: testInfo.outputPath(`usage-${width}-${theme}.png`) });
      const periodRequest = page.waitForRequest(
        (request) =>
          request.url().includes("/api/usage/report") &&
          new URL(request.url()).searchParams.get("days") === "7",
      );
      await page.getByTestId("usage-period").selectOption("7");
      await periodRequest;
      const hourRequest = page.waitForRequest(
        (request) =>
          request.url().includes("/api/usage/report") &&
          new URL(request.url()).searchParams.get("granularity") === "hour",
      );
      await page.getByTestId("usage-granularity-hour").click();
      await hourRequest;
      const agentRequest = page.waitForRequest(
        (request) =>
          request.url().includes("/api/usage/report") &&
          new URL(request.url()).searchParams.get("agent") === "codex",
      );
      await page.getByTestId("usage-agent").selectOption("codex");
      await agentRequest;
      await expect(section).toContainText("Filtered to Codex");
      await expect(page.getByTestId("usage-models")).toBeVisible();
      await expect(page.getByTestId("usage-models")).toContainText("gpt-6");
      await expect(section).toContainText("Coverage");
      expect(await section.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.reload();
      await expect(section).toBeVisible();
    });
  }

test("usage handles errors, retry and empty reports", async ({ page }) => {
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  let failed = true;
  await page.route("**/api/usage/report?*", (route) =>
    route.fulfill(
      failed
        ? { status: 503, json: { error: "Unavailable" } }
        : {
            json: {
              ...report,
              totals: emptyNumbers,
              agents: [],
              models: [],
              buckets: [],
              coverage: { ...report.coverage, indexed_sessions: 0 },
            },
          },
    ),
  );
  await page.route("**/api/usage/quotas", (route) => route.fulfill({ json: quotas }));
  await page.goto("/settings");
  await settingsSection(page, "usage");
  await expect(page.getByTestId("settings-usage").getByRole("alert")).toContainText(
    "Usage could not be loaded",
    { timeout: 20000 },
  );
  failed = false;
  await page.getByTestId("usage-refresh").click();
  await expect(page.getByTestId("settings-usage")).toContainText(
    "No request-level usage in this period yet",
  );
});

test("usage shows one quota card per configured provider", async ({ page }) => {
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  const checkedAt = new Date().toISOString();
  await page.route("**/api/usage/report?*", (route) => route.fulfill({ json: report }));
  await page.route("**/api/usage/quotas", (route) =>
    route.fulfill({
      json: {
        accounts: [
          {
            provider: "claude",
            provider_id: "claude-work",
            name: "Claude Work",
            status: "available",
            message: null,
            checked_at: checkedAt,
            windows: [{ label: "5-hour window", used_percent: 42, resets_at: null }],
          },
          {
            provider: "claude",
            provider_id: "claude-personal",
            name: "Claude Personal",
            status: "signed_out",
            message: "No readable local account login.",
            checked_at: checkedAt,
            windows: [],
          },
        ],
      },
    }),
  );
  await page.goto("/settings");
  await settingsSection(page, "usage");
  await page.getByTestId("usage-quotas").locator("summary").click();
  const work = page.getByTestId("usage-quota-claude-work");
  await expect(work).toContainText("Claude · Claude Work");
  await expect(work).toContainText("42% used");
  const personal = page.getByTestId("usage-quota-claude-personal");
  await expect(personal).toContainText("Claude · Claude Personal");
  await expect(personal).toContainText("No readable local account login.");
});
