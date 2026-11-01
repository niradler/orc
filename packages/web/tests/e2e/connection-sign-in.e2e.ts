import { expect, test } from "@playwright/test";
import { settingsSection } from "./_chat-ui";
import { gotoView } from "./_helpers";

test("an OAuth connection signs in through the provider redirect and signs out", async ({
  page,
}) => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  await page.route("**/api/integrations/**", async (route) => {
    const request = route.request();
    const { pathname, origin } = new URL(request.url());
    const path = pathname.replace(/^\/api/, "");
    calls.push({ method: request.method(), path, body: request.postDataJSON() });
    if (path === "/integrations/connections")
      return route.fulfill({
        json: { connections: [{ name: "remote", type: "http", description: null, enabled: true }] },
      });
    if (path === "/integrations/connections/remote")
      return route.fulfill({
        json: {
          name: "remote",
          enabled: true,
          source: { type: "http", url: "https://mcp.example.com/mcp", oauthClientId: "orc" },
        },
      });
    if (path === "/integrations/connections/remote/authorize" && request.method() === "POST")
      // Stands in for the provider, which sends the browser straight back with a code.
      return route.fulfill({
        json: {
          status: "redirect",
          authorizationUrl: `${origin}/integrations/oauth/remote/callback?code=abc&state=s1`,
        },
      });
    if (path.startsWith("/integrations/connections/remote/authorize"))
      return route.fulfill({ status: 204 });
    return route.fulfill({ status: 404, json: { error: "unexpected" } });
  });

  await gotoView(page, "settings");
  await settingsSection(page, "integrations");
  await page.getByTestId("integrations-tab-connections").click();
  await page.getByRole("button", { name: "Edit remote" }).click();
  await expect(page.getByTestId("connection-auth")).toContainText("OAuth");
  await page.getByTestId("connection-sign-in").click();

  await expect(page.getByTestId("integration-callback")).toContainText("Signed in");
  const origin = new URL(page.url()).origin;
  expect(calls.find((call) => call.path.endsWith("/authorize"))?.body).toEqual({
    redirectUrl: `${origin}/integrations/oauth/remote/callback`,
  });
  expect(
    calls.filter((call) => call.path.endsWith("/authorize/callback")).map((call) => call.body),
  ).toEqual([{ code: "abc", state: "s1" }]);

  await page.getByRole("link", { name: "Back to connections" }).click();
  await page.getByRole("button", { name: "Edit remote" }).click();
  await page.getByTestId("connection-sign-out").click();
  await expect(page.getByText("Signed out.")).toBeVisible();
  expect(calls.some((call) => call.method === "DELETE" && call.path.endsWith("/authorize"))).toBe(
    true,
  );
});

test("the callback page reports a denied sign-in", async ({ page }) => {
  await gotoView(page, "settings");
  await page.goto("/integrations/oauth/remote/callback?error=access_denied");
  await expect(page.getByTestId("integration-callback").getByRole("alert")).toContainText(
    "access_denied",
  );
});
