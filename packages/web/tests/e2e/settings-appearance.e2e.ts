import { expect, test } from "@playwright/test";
import { settingsSection } from "./_chat-ui";
import { API_SECRET, gotoView } from "./_helpers";

/** Theme and font size moved out of the workspace header into Settings → Appearance.
 *  Theme is a server preference (shared across browsers); text size, fonts and chat
 *  layout are per-browser reading preferences. Run: bun packages/web/scripts/run-e2e.ts settings-appearance */

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

test("text size scales this browser per device, survives reload, and is not shared with other browsers", async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoView(page, "settings");
  await settingsSection(page, "appearance");
  const rootSize = () =>
    page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
  const base = await rootSize();
  await expect(page.locator("html")).not.toHaveAttribute("data-font-size", /.+/);
  await expect(page.getByTestId("settings-desktop-default")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByTestId("settings-desktop-large").click();
  await expect(page.locator("html")).toHaveAttribute("data-font-size", "large");
  await expect(page.getByTestId("settings-desktop-large")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(rootSize).toBeCloseTo(base * 1.125, 1);

  // Per-browser preference: a reload keeps it.
  await page.reload();
  await settingsSection(page, "appearance");
  await expect(page.locator("html")).toHaveAttribute("data-font-size", "large");
  await expect(page.getByTestId("settings-desktop-large")).toHaveAttribute("aria-pressed", "true");

  // The phone size is stored separately and applies only at phone width.
  await page.getByTestId("settings-phone-x-large").click();
  await expect(page.locator("html")).toHaveAttribute("data-font-size", "large");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("html")).toHaveAttribute("data-font-size", "x-large");
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator("html")).toHaveAttribute("data-font-size", "large");

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
    await expect(fresh.getByTestId("settings-desktop-default")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  } finally {
    await context.close();
  }

  await page.getByTestId("settings-desktop-default").click();
  await page.getByTestId("settings-phone-default").click();
  await expect(page.locator("html")).not.toHaveAttribute("data-font-size", /.+/);
  await expect.poll(rootSize).toBeCloseTo(base, 1);
});

test("chat defaults to the system font, wide and large on desktop, and each chat setting applies", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoView(page, "settings");
  await settingsSection(page, "appearance");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-font", "system");
  await expect(html).toHaveAttribute("data-chat-font", "interface");
  await expect(html).toHaveAttribute("data-chat-text", "large");
  await expect(html).toHaveAttribute("data-chat-width", "wide");
  await expect(html).toHaveAttribute("data-dark-background", "charcoal");
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await background()).toBe("rgb(31, 31, 30)");
  await page.getByTestId("settings-darkBackground-black").click();
  expect(await background()).toBe("rgb(0, 0, 0)");
  await page.getByTestId("settings-darkBackground-charcoal").click();
  expect(await background()).toBe("rgb(31, 31, 30)");
  const chatVar = (name: string) =>
    page.evaluate(
      (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
      name,
    );
  expect(await chatVar("--chat-text")).toBe("18px");
  expect(await chatVar("--chat-width")).toBe("64rem");

  await page.getByTestId("settings-chatFont-serif").click();
  await expect(html).toHaveAttribute("data-chat-font", "serif");
  expect(await chatVar("--font-reading")).toContain("serif");
  await page.getByTestId("settings-chatDesktop-x-large").click();
  expect(await chatVar("--chat-text")).toBe("20px");
  await page.getByTestId("settings-chatWidth-full").click();
  expect(await chatVar("--chat-width")).toBe("100%");
  await page.getByTestId("settings-font-geist").click();
  await expect(html).toHaveAttribute("data-font", "geist");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(html).toHaveAttribute("data-chat-text", "default");

  await page.reload();
  await expect(html).toHaveAttribute("data-chat-font", "serif");
  await expect(html).toHaveAttribute("data-font", "geist");

  await page.setViewportSize({ width: 1280, height: 800 });
  await settingsSection(page, "appearance");
  for (const id of [
    "settings-chatFont-interface",
    "settings-chatDesktop-large",
    "settings-chatWidth-wide",
    "settings-font-system",
  ])
    await page.getByTestId(id).click();
  await expect(html).toHaveAttribute("data-font", "system");
});

test("another open tab follows an appearance change, and a phone keeps an older shared size", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoView(page, "settings");
  await settingsSection(page, "appearance");
  const other = await context.newPage();
  await other.setViewportSize({ width: 1280, height: 800 });
  await gotoView(other, "tasks");
  await expect(other.locator("html")).toHaveAttribute("data-chat-width", "wide");
  await page.getByTestId("settings-chatWidth-full").click();
  await expect(other.locator("html")).toHaveAttribute("data-chat-width", "full");
  await page.getByTestId("settings-chatWidth-wide").click();
  await other.close();

  await page.evaluate(() => {
    localStorage.removeItem("orc_font_size_phone");
    localStorage.setItem("orc_font_size", "large");
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-font-size", "large");
  await page.evaluate(() => localStorage.removeItem("orc_font_size"));
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
  await expect(page.getByTestId("settings-phone-default")).toBeVisible();
  // Touch-sized controls: every appearance button meets the 44px minimum.
  for (const id of ["settings-theme-light", "settings-phone-large", "settings-chatPhone-large"]) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  await page.getByTestId("settings-phone-large").click();
  await expect(page.locator("html")).toHaveAttribute("data-font-size", "large");
  await page.getByTestId("settings-phone-default").click();
  await expect(page.locator("html")).not.toHaveAttribute("data-font-size", /.+/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
