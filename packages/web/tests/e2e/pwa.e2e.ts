import { expect, test } from "@playwright/test";
import { settingsSection } from "./_chat-ui";
import { gotoView, repoRoot } from "./_helpers";

test.use({ serviceWorkers: "allow" });

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

test("manifest link sends credentials so auth proxies let it through", async ({ page }) => {
  await gotoView(page, "activity");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "crossorigin",
    "use-credentials",
  );
});

test("service worker controls the app and serves the shell offline", async ({ page, context }) => {
  await gotoView(page, "activity");
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
  await gotoView(page, "activity");
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
      data: JSON.stringify({
        title: "Approval needed",
        body: "Run it?",
        url: "/activity?notifications=open",
        tag,
      }),
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
    url: "/activity?notifications=open",
  });
});

test("settings explains and offers device notifications", async ({ page }) => {
  await gotoView(page, "settings");
  await settingsSection(page, "notifications");
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
  await expect(page.getByTestId("push-enable")).toBeVisible();
});

for (const width of [1440, 390]) {
  test.describe(`subscribed notification settings at ${width}px`, () => {
    test.use({
      serviceWorkers: "block",
      viewport: { width, height: 900 },
      hasTouch: width < 640,
      isMobile: width < 640,
    });

    test("should show and persist the selected Jobs notification topic", async ({ page }) => {
      await page.addInitScript(() => {
        Object.defineProperty(Notification, "permission", { get: () => "granted" });
        Object.defineProperty(navigator.serviceWorker, "getRegistration", {
          value: async () => ({
            pushManager: {
              getSubscription: async () => ({
                endpoint: "https://fcm.googleapis.com/fcm/send/demo-device",
                getKey: () => new Uint8Array([1, 2, 3]).buffer,
              }),
            },
          }),
        });
      });
      let device = {
        id: "demo-notification-device",
        label: "Demo browser",
        endpoint_host: "fcm.googleapis.com",
        topics: ["attention", "chat", "jobs"],
        created_at: Date.now(),
        last_success_at: null,
        failure_count: 0,
      };
      const updates: string[][] = [];
      await page.route("**/api/push/subscriptions**", async (route) => {
        const method = route.request().method();
        if (method === "PATCH") {
          const payload = route.request().postDataJSON() as { topics: string[] };
          updates.push(payload.topics);
          device = { ...device, topics: payload.topics };
        }
        await route.fulfill({ json: method === "GET" ? [device] : device });
      });
      await page.route("**/api/projects**", (route) =>
        route.fulfill({
          json: {
            projects: [{ id: "demo-project", name: "Demo project", status: "active" }],
            total: 1,
            has_more: false,
          },
        }),
      );
      await gotoView(page, "settings");
      await settingsSection(page, "notifications");
      const jobs = page.getByTestId("push-topic-jobs");
      await expect(jobs).toBeChecked();
      await expect(
        page.getByText("Job results you asked to be notified about", { exact: true }),
      ).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const topics = ["attention", "chat", "jobs"].map((topic) => `push-topic-${topic}`);
      for (const id of [
        ...topics,
        "notification-sound-enabled",
        "notification-mute-demo-project",
      ]) {
        const label = page.locator("label").filter({ has: page.getByTestId(id) });
        await expect(label).toBeVisible();
        const box = await label.boundingBox();
        if (!box) throw new Error(`Missing checkbox label bounds: ${id}`);
        if (width < 640) {
          expect(box.height, id).toBeGreaterThanOrEqual(44);
          expect(box.width, id).toBeGreaterThanOrEqual(44);
        } else expect(box.height, id).toBeLessThanOrEqual(32);
      }
      if (process.env.PW_REVIEW_SCREENSHOTS === "1")
        await page.screenshot({
          path: `${repoRoot()}/.claude/docs/pr222-jobs-notifications-${width}.png`,
          fullPage: true,
        });
      await jobs.click();
      await expect.poll(() => updates).toEqual([["attention", "chat"]]);
      await expect(jobs).not.toBeChecked();
      await page.reload();
      await expect(page.getByTestId("push-topic-jobs")).not.toBeChecked();
      await expect(page.getByTestId("push-topic-attention")).toBeChecked();
      await expect(page.getByTestId("push-topic-chat")).toBeChecked();
    });
  });
}
