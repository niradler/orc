import { expect, test } from "@playwright/test";
import { settingsSection } from "./_chat-ui";
import { gotoView } from "./_helpers";

test("serves an installable manifest and public PWA files without auth", async ({ request }) => {
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.status()).toBe(200);
  expect(manifest.headers()["content-type"]).toContain("application/manifest+json");
  const body = (await manifest.json()) as { display: string; icons: { src: string }[] };
  expect(body.display).toBe("standalone");
  for (const icon of body.icons) expect((await request.get(icon.src)).status()).toBe(200);
  const worker = await request.get("/sw.js");
  expect(worker.status()).toBe(200);
  expect(worker.headers()["cache-control"]).toContain("no-cache");
  expect((await request.get("/badge-96.png")).status()).toBe(200);
});

test("service worker controls the app and serves the shell offline", async ({ page, context }) => {
  await gotoView(page, "dashboard");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.locator("#root")).not.toBeEmpty();
    await expect(page).toHaveTitle(/ORC/);
  } finally {
    await context.setOffline(false);
  }
});

type Shown = { title: string; tag: string; url: string };

test("push messages notify only when ORC is not focused", async ({ page, context }) => {
  await gotoView(page, "dashboard");
  await page.evaluate(() => navigator.serviceWorker.ready);
  const origin = new URL(page.url()).origin;
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  // Headless Chromium denies notification permission inside workers, so record the call instead.
  await worker.evaluate(() => {
    const scope = self as unknown as ServiceWorkerGlobalScope & { shown: Shown[] };
    scope.shown = [];
    scope.registration.showNotification = async (title, options) => {
      scope.shown.push({ title, tag: options?.tag ?? "", url: options?.data?.url });
    };
  });
  const cdp = await context.newCDPSession(page);
  const registration = new Promise<string>((resolve) => {
    cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
      const match = registrations.find(
        (entry: { scopeURL: string; isDeleted: boolean }) =>
          entry.scopeURL.startsWith(origin) && !entry.isDeleted,
      );
      if (match) resolve(match.registrationId);
    });
  });
  await cdp.send("ServiceWorker.enable");
  const registrationId = await registration;
  const push = (tag: string) =>
    cdp.send("ServiceWorker.deliverPushMessage", {
      origin,
      registrationId,
      data: JSON.stringify({ title: "Approval needed", body: "Run it?", url: "/attention", tag }),
    });
  const shown = () =>
    worker.evaluate(() => (self as unknown as { shown: Shown[] }).shown.map((entry) => entry.tag));

  await push("while-focused");
  await page.goto("about:blank");
  await push("while-away");
  await expect.poll(shown).toEqual(["while-away"]);
  expect(await worker.evaluate(() => (self as unknown as { shown: Shown[] }).shown[0])).toEqual({
    title: "Approval needed",
    tag: "while-away",
    url: "/attention",
  });
});

test("settings explains and offers device notifications", async ({ page }) => {
  await gotoView(page, "settings");
  await settingsSection(page, "notifications");
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
  await expect(page.getByTestId("push-enable")).toBeVisible();
});
