import { expect, test } from "@playwright/test";
import { settingsSection } from "./_chat-ui";
import { API_BASE, API_SECRET, AUTH_HEADERS } from "./_helpers";

test.afterEach(async ({ request }) => {
  await request.patch(`${API_BASE}/settings`, {
    headers: AUTH_HEADERS,
    data: { theme: "dark", terminal_font: "" },
  });
});

test("401 prompts, rejects wrong secrets, and signs in with an HttpOnly cookie", async ({
  page,
  context,
}) => {
  await page.goto("/settings");
  await expect(page.getByTestId("api-login")).toBeVisible();
  await page.screenshot({ path: "../../.claude/docs/browser-login-modal.png" });
  await expect(page.getByTestId("api-login-valid-until")).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await page.getByTestId("api-login-secret").fill("wrong-secret");
  await page.getByTestId("api-login-submit").click();
  await expect(page.getByTestId("api-login-error")).toBeVisible();
  await page.getByTestId("api-login-secret").fill(API_SECRET);
  await page.getByTestId("api-login-submit").click();
  await expect(page.getByTestId("settings-save")).toBeVisible();
  await expect(page.locator("#settings-api-secret")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith("orc_api_secret")),
    ),
  ).toEqual([]);
  const cookie = (await context.cookies()).find((entry) => entry.name === "orc_session");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.value).not.toContain(API_SECRET);
  await page.reload();
  await expect(page.getByTestId("settings-save")).toBeVisible();
  await expect(page.getByTestId("api-login")).toHaveCount(0);
});

test("the chosen valid-until date sets the session expiry", async ({ page, context }) => {
  await page.goto("/settings");
  const validUntil = new Date(Date.now() + 3 * 86_400_000);
  const value = `${validUntil.getFullYear()}-${String(validUntil.getMonth() + 1).padStart(2, "0")}-${String(validUntil.getDate()).padStart(2, "0")}`;
  await page.getByTestId("api-login-secret").fill(API_SECRET);
  await page.getByTestId("api-login-valid-until").fill(value);
  await page.getByTestId("api-login-submit").click();
  await expect(page.getByTestId("settings-save")).toBeVisible();
  const cookie = (await context.cookies()).find((entry) => entry.name === "orc_session");
  const endOfDay = new Date(`${value}T23:59:59`).getTime() / 1000;
  expect(Math.abs((cookie?.expires ?? 0) - endOfDay)).toBeLessThan(5);
});

test("Security creates an API token and signs the browser out", async ({
  page,
  request,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  await expect(page.getByTestId("api-login")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("login-390.png") });
  await page.getByTestId("api-login-secret").fill(API_SECRET);
  await page.getByTestId("api-login-submit").click();
  await settingsSection(page, "security");
  await expect(page.getByTestId("security-session")).toContainText("signed in until");
  await expect(page.getByTestId("security-session-days")).toHaveValue("30");
  await page.getByTestId("security-token-secret").fill(API_SECRET);
  await page.getByTestId("security-token-create").click();
  const token = await page.getByTestId("security-token-value").inputValue();
  await page.screenshot({ path: testInfo.outputPath("security-390.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: testInfo.outputPath("security-1440.png"), fullPage: true });
  expect(token).not.toBe(API_SECRET);
  const projects = await request.get(`${API_BASE}/projects`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(projects.status()).toBe(200);
  await page.getByTestId("security-sign-out").click();
  await expect(page.getByTestId("api-login")).toBeVisible();
});

test("login survives reload and preferences survive a fresh browser context", async ({
  page,
  browser,
}) => {
  await page.goto("/settings");
  await page.getByTestId("api-login-secret").fill(API_SECRET);
  await page.getByTestId("api-login-submit").click();
  await settingsSection(page, "appearance");
  await page.getByTestId("settings-theme-light").click();
  await settingsSection(page, "terminals");
  await page.locator("#settings-terminal-font").fill("Test Mono");
  await page.getByTestId("settings-terminal-save").click();
  await expect(page.getByRole("status")).toContainText("Terminal font saved");
  await page.reload();
  await expect(page.getByTestId("settings-terminal-save")).toBeVisible();
  await expect(page.getByTestId("api-login")).toHaveCount(0);
  const context = await browser.newContext();
  const fresh = await context.newPage();
  try {
    await fresh.goto(new URL("/settings", page.url()).href);
    await fresh.getByTestId("api-login-secret").fill(API_SECRET);
    await fresh.getByTestId("api-login-submit").click();
    await expect(fresh.locator("html")).toHaveAttribute("data-theme", "light");
    await settingsSection(fresh, "terminals");
    await expect(fresh.locator("#settings-terminal-font")).toHaveValue("Test Mono");
  } finally {
    await context.close();
  }
});

test("a stale secret from an older build prompts again and a runtime 401 reopens login", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, "stale"),
  );
  await page.goto("/settings");
  await expect(page.getByTestId("api-login")).toBeVisible();
  await page.getByTestId("api-login-secret").fill(API_SECRET);
  await page.getByTestId("api-login-submit").click();
  await expect(page.getByTestId("settings-save")).toBeVisible();
  await page.route("**/api/settings", (route) =>
    route.fulfill({ status: 401, json: { error: "Unauthorized" } }),
  );
  await settingsSection(page, "appearance");
  await page.getByTestId("settings-theme-light").click();
  await expect(page.getByTestId("api-login")).toBeVisible();
});

test("open API loads without prompting and connection failures offer retry", async ({ page }) => {
  await page.route("**/api/settings", (route) => route.fulfill({ json: {} }));
  await page.goto("/settings");
  await expect(page.getByTestId("settings-save")).toBeVisible();
  await expect(page.getByTestId("api-login")).toHaveCount(0);
  await page.route("**/api/settings", (route) => route.fulfill({ status: 503, json: {} }));
  await page.reload();
  await expect(page.getByTestId("api-access-retry")).toBeVisible();
  await page.unroute("**/api/settings");
  await page.getByTestId("api-access-retry").click();
  await expect(page.getByTestId("api-login")).toBeVisible();
});

test("changing the API address does not forward credentials from the previous server", async ({
  page,
}) => {
  await page.goto("/settings");
  await page.getByTestId("api-login-secret").fill(API_SECRET);
  await page.getByTestId("api-login-submit").click();
  let forwardedSecret: string | undefined;
  await page.route("**/other-api/settings", (route) => {
    forwardedSecret = route.request().headers().authorization;
    return route.fulfill({ status: 401, json: { error: "Unauthorized" } });
  });
  await page.getByTestId("settings-api-url").fill("/other-api");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("api-login")).toBeVisible();
  expect(forwardedSecret).toBeUndefined();
});
