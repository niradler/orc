import { expect, test } from "@playwright/test";
import { settingsSection } from "./_chat-ui";
import { API_SECRET, gotoView } from "./_helpers";

/** Theme and font size moved out of the workspace header into Settings → Appearance.
 *  Theme is a server preference (shared across browsers); font size is a per-browser
 *  reading preference. Run: bun packages/web/scripts/run-e2e.ts settings-appearance */

test("theme is saved from Settings → Appearance, persists, and the header switcher is gone", async ({
  page,
}) => {
  await page.request.patch("/api/settings", {
    headers: { Authorization: `Bearer ${API_SECRET}` },
    data: { theme: "dark" },
  });
  await gotoView(page, "settings");
  // The old header theme toggle no longer exists on any page.
  await expect(page.getByTestId("theme-toggle")).toHaveCount(0);
  await settingsSection(page, "appearance");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByTestId("settings-theme-dark")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("settings-theme-light")).toHaveAttribute("aria-pressed", "false");

  const saved = page.waitForResponse(
    (response) => response.url().endsWith("/settings") && response.request().method() === "PATCH",
  );
  await page.getByTestId("settings-theme-light").click();
  expect((await saved).status()).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByTestId("settings-theme-light")).toHaveAttribute("aria-pressed", "true");

  // A reload reads the server preference back, not a stale local value.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await settingsSection(page, "appearance");
  await expect(page.getByTestId("settings-theme-light")).toHaveAttribute("aria-pressed", "true");

  // Restore the shared default so later specs start from a known theme.
  const restored = page.waitForResponse(
    (response) => response.url().endsWith("/settings") && response.request().method() === "PATCH",
  );
  await page.getByTestId("settings-theme-dark").click();
  expect((await restored).status()).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("font size scales this browser, survives reload, and is not shared with other browsers", async ({
  page,
  browser,
}) => {
  await gotoView(page, "settings");
  await settingsSection(page, "appearance");
  const rootSize = () =>
    page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
  const base = await rootSize();
  await expect(page.locator("html")).not.toHaveAttribute("data-font-size", /.+/);
  await expect(page.getByTestId("settings-font-size-default")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByTestId("settings-font-size-large").click();
  await expect(page.locator("html")).toHaveAttribute("data-font-size", "large");
  await expect(page.getByTestId("settings-font-size-large")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(rootSize).toBeCloseTo(base * 1.125, 1);

  // Per-browser preference: a reload keeps it.
  await page.reload();
  await settingsSection(page, "appearance");
  await expect(page.locator("html")).toHaveAttribute("data-font-size", "large");
  await expect(page.getByTestId("settings-font-size-large")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByTestId("settings-font-size-x-large").click();
  await expect(page.locator("html")).toHaveAttribute("data-font-size", "x-large");
  await expect.poll(rootSize).toBeCloseTo(base * 1.25, 1);

  // A different browser has no stored preference and starts at the default size.
  const context = await browser.newContext();
  const fresh = await context.newPage();
  try {
    await fresh.goto(new URL("/settings", page.url()).href);
    await expect(fresh.locator("html")).not.toHaveAttribute("data-font-size", /.+/);
    await fresh.getByTestId("api-login-secret").fill(API_SECRET);
    await fresh.getByTestId("api-login-submit").click();
    await settingsSection(fresh, "appearance");
    await expect(fresh.locator("html")).not.toHaveAttribute("data-font-size", /.+/);
    await expect(fresh.getByTestId("settings-font-size-default")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  } finally {
    await context.close();
  }

  await page.getByTestId("settings-font-size-default").click();
  await expect(page.locator("html")).not.toHaveAttribute("data-font-size", /.+/);
  await expect.poll(rootSize).toBeCloseTo(base, 1);
});

test("appearance is reachable and usable on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.request.patch("/api/settings", {
    headers: { Authorization: `Bearer ${API_SECRET}` },
    data: { theme: "dark" },
  });
  await gotoView(page, "settings");
  await settingsSection(page, "appearance");
  await expect(page.getByTestId("settings-theme-dark")).toBeVisible();
  await expect(page.getByTestId("settings-font-size-default")).toBeVisible();
  // Touch-sized controls: every appearance button meets the 44px minimum.
  for (const id of ["settings-theme-light", "settings-font-size-large"]) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  await page.getByTestId("settings-font-size-large").click();
  await expect(page.locator("html")).toHaveAttribute("data-font-size", "large");
  await page.getByTestId("settings-font-size-default").click();
  await expect(page.locator("html")).not.toHaveAttribute("data-font-size", /.+/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
