import { expect, test } from "@playwright/test";
import { settingsSection } from "./_chat-ui";
import { API_SECRET } from "./_helpers";

const totals = { sessions: 4, tokens: 125000, unknown_sessions: 1, estimated_sessions: 1 };
const history = {
  days: 30,
  since: new Date().toISOString(),
  totals,
  agents: [{ ...totals, agent: "codex" }],
  daily: [{ ...totals, date: "2026-11-06" }],
};
const quotas = {
  accounts: [
    {
      provider: "codex",
      status: "available",
      message: null,
      checked_at: new Date().toISOString(),
      windows: [
        { label: "5-hour window", used_percent: 35, resets_at: "2026-11-07T12:00:00.000Z" },
        { label: "7-day window", used_percent: 100, resets_at: null },
      ],
    },
    {
      provider: "claude",
      status: "signed_out",
      message: "No readable local account login.",
      checked_at: new Date().toISOString(),
      windows: [],
    },
  ],
};

for (const width of [1440, 390])
  for (const theme of ["dark", "light"]) {
    test(`usage history and quotas at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        ({ secret, theme }) => {
          localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
          localStorage.setItem("orc_theme", theme);
        },
        { secret: API_SECRET, theme },
      );
      await page.route("**/api/usage/history?*", (route) => route.fulfill({ json: history }));
      await page.route("**/api/usage/quotas", (route) => route.fulfill({ json: quotas }));
      await page.goto("/settings");
      await settingsSection(page, "usage");
      const section = page.getByTestId("settings-usage");
      await expect(section).toBeVisible();
      await expect(page.getByTestId("usage-total-tokens")).toHaveText("125,000");
      await expect(section).toContainText("Sessions without reported token counts: 1");
      await expect(section).toContainText("Cursor sessions");
      await expect(section.getByRole("progressbar").first()).toHaveAttribute("aria-valuenow", "35");
      await expect(section.getByRole("progressbar").last()).toHaveAttribute("aria-valuenow", "100");
      await expect(page.getByTestId("usage-quota-claude")).toContainText(
        "No readable local account login",
      );
      await expect(page.getByTestId("usage-daily")).not.toHaveAttribute("open");
      await page.getByTestId("usage-daily").locator("summary").click();
      await expect(section).toContainText("2026-11-06");
      const request = page.waitForRequest("**/api/usage/history?days=7");
      await page.getByTestId("usage-period").selectOption("7");
      await request;
      expect(await section.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await section.screenshot({ path: testInfo.outputPath(`usage-${width}-${theme}.png`) });
      await page.reload();
      await expect(section).toBeVisible();
    });
  }

test("usage handles errors, retry and empty history", async ({ page }) => {
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  let failed = true;
  await page.route("**/api/usage/history?*", (route) =>
    route.fulfill(
      failed
        ? { status: 503, json: { error: "Unavailable" } }
        : {
            json: {
              ...history,
              totals: { sessions: 0, tokens: 0, unknown_sessions: 0, estimated_sessions: 0 },
              agents: [],
              daily: [],
            },
          },
    ),
  );
  await page.route("**/api/usage/quotas", (route) => route.fulfill({ json: quotas }));
  await page.goto("/settings");
  await settingsSection(page, "usage");
  await expect(page.getByTestId("settings-usage").getByRole("alert")).toContainText(
    "Session history could not be loaded",
    { timeout: 20000 },
  );
  failed = false;
  await page.getByTestId("usage-refresh").click();
  await expect(page.getByTestId("settings-usage")).toContainText(
    "No imported sessions started in this period",
  );
});
