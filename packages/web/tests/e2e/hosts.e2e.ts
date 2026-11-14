import { expect, test } from "@playwright/test";
import { API_SECRET, gotoView } from "./_helpers";

test("saved ORC servers keep their token and headers, switch, and come back", async ({ page }) => {
  await gotoView(page, "settings");
  await page.goto("/settings?settingsSection=hosts");
  await expect(page.getByTestId("hosts-settings")).toBeVisible();
  await expect(page.getByTestId("host-badge-api").first()).toHaveText("API");
  await expect(page.getByTestId("host-row-ssh")).toBeVisible();
  await expect(page.getByTestId("host-badge-ssh")).toHaveText("SSH");

  let authorization: string | undefined;
  let proxyHeader: string | undefined;
  await page.route("**/other-api/**", (route) => {
    authorization = route.request().headers().authorization;
    proxyHeader = route.request().headers()["cf-access-client-secret"];
    return route.fulfill({ status: 401, json: { error: "Unauthorized" } });
  });

  await page.getByTestId("api-host-add").click();
  await page.getByTestId("api-host-name").fill("Lab");
  await page.getByTestId("api-host-url").fill("/other-api");
  await page.getByTestId("api-host-token").fill("lab-jwt-token");
  await page.getByTestId("api-host-header-add").click();
  await page.getByTestId("api-host-header-name-0").fill("CF-Access-Client-Secret");
  await page.getByTestId("api-host-header-value-0").fill("proxy-secret");
  await expect(page.getByTestId("api-host-header-value-0")).toHaveAttribute("type", "password");

  await page.getByTestId("api-host-test").click();
  await expect(page.getByTestId("api-host-test-result")).toContainText("Reached the server");

  await page.getByTestId("api-host-save").click();
  await expect(page.getByTestId("api-login")).toBeVisible();
  expect(authorization).toBe("Bearer lab-jwt-token");
  expect(proxyHeader).toBe("proxy-secret");

  await page.getByTestId("api-login-previous").click();
  await expect(page.getByTestId("settings-shell")).toBeVisible();
  await expect(page.getByTestId("api-login")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("orc_api_url"))).toBe("/api");

  const stored = await page.evaluate(() => localStorage.getItem("orc_api_hosts"));
  expect(stored).toContain("Lab");
  expect(stored).toContain("lab-jwt-token");

  const row = page.getByTestId(/^api-host-/).filter({ hasText: "Lab" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByTestId("api-host-token")).toHaveAttribute("type", "password");
  await expect(page.getByTestId("api-host-token")).toHaveValue("lab-jwt-token");
  await expect(page.getByTestId("api-host-header-value-0")).toHaveValue("proxy-secret");
  await page.getByRole("button", { name: "Close server editor" }).click();

  await page.reload();
  await page.goto("/settings?settingsSection=hosts");
  await expect(page.getByTestId(/^api-host-/).filter({ hasText: "Lab" })).toBeVisible();
});

test("deleting the active saved server falls back to this server", async ({ page }) => {
  await gotoView(page, "settings");
  await page.evaluate((secret) => {
    localStorage.setItem(
      "orc_api_hosts",
      JSON.stringify([{ id: "lab", label: "Lab", url: "/api", token: secret, headers: [] }]),
    );
    localStorage.setItem("orc_api_active_host", "lab");
  }, API_SECRET);
  await page.goto("/settings?settingsSection=hosts");
  const row = page.getByTestId("api-host-lab");
  await expect(row).toBeVisible();
  await expect(row.getByText("Active")).toBeVisible();
  await page.getByTestId("api-host-delete-lab").click();
  await page.getByTestId("confirm-dialog-confirm").click();
  await expect(row).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("orc_api_hosts"))).not.toContain(
    API_SECRET,
  );
  expect(await page.evaluate(() => localStorage.getItem("orc_api_url"))).toBe("/api");
  expect(await page.evaluate(() => localStorage.getItem("orc_api_active_host"))).toBe(
    "__current__",
  );
});

test("phone settings opens a list, then a section with back to the list", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoView(page, "settings");
  await expect(page.getByTestId("settings-list")).toBeVisible();
  await expect(page.getByTestId("settings-back")).toBeHidden();
  await page.getByTestId("settings-list-hosts").click();
  await expect(page.getByTestId("settings-back")).toBeVisible();
  await expect(page.getByTestId("hosts-settings")).toBeVisible();
  await expect(page.getByTestId("host-row-ssh")).toBeVisible();
  await expect(page.getByTestId("settings-list")).toBeHidden();

  await page.getByTestId("settings-back").click();
  await expect(page.getByTestId("settings-list")).toBeVisible();
  await expect(page).not.toHaveURL(/settingsSection=/);

  await page.goto("/settings?settingsSection=hosts");
  await expect(page.getByTestId("settings-back")).toBeVisible();
  await expect(page.getByTestId("hosts-settings")).toBeVisible();
});

test("desktop keeps the grouped sidebar and opens each panel", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoView(page, "settings");
  await expect(page.getByTestId("settings-list")).toBeHidden();
  await page.getByTestId("settings-section-hosts").click();
  await expect(page.getByTestId("settings-section-hosts")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("hosts-settings")).toBeVisible();
  await expect(page.getByTestId("host-badge-api").first()).toHaveText("API");
  await expect(page.getByTestId("host-badge-ssh")).toHaveText("SSH");
  await page.getByTestId("ssh-host-change").click();
  await expect(page.getByTestId("ssh-settings")).toBeVisible();
  await page.getByTestId("settings-section-agents").click();
  await expect(page.getByTestId("agents-tab-providers")).toBeVisible();
  await page.getByTestId("agents-tab-chat").click();
  await expect(page.getByTestId("chat-settings")).toBeVisible();
});
