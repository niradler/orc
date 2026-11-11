import { expect, test } from "@playwright/test";
import { gotoView } from "./_helpers";

test("should report the real failure when a deploy replaced a view chunk", async ({
  page,
  context,
}) => {
  // The tab already used its one automatic reload, so the panel is what stays visible.
  await page.addInitScript(() =>
    sessionStorage.setItem("orc_stale_build_reload_at", String(Date.now())),
  );
  // Network-level blocking, like a server that no longer has the chunk: Playwright
  // route interception of an ES module resolves the import instead of failing it.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setBlockedURLs", { urls: ["*Terminals-*.js"] });

  await gotoView(page, "terminals");

  const panel = page.getByTestId("route-error");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("ORC was updated");
  await expect(page.getByTestId("route-error-message")).toContainText(
    "Failed to fetch dynamically imported module",
  );
  // React Router's developer page told users nothing about the real error.
  await expect(page.getByText("Hey developer")).toHaveCount(0);
});

test("should reload once to load the new build before showing the panel", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    const loads = Number(sessionStorage.getItem("probe_loads") ?? 0);
    sessionStorage.setItem("probe_loads", String(loads + 1));
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setBlockedURLs", { urls: ["*Terminals-*.js"] });

  await gotoView(page, "terminals");

  // The chunk still fails after the reload, so the guard stops looping and the
  // panel explains what happened.
  await expect(page.getByTestId("route-error")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("probe_loads"))).toBe("2");
});
