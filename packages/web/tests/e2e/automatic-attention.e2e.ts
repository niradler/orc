import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { notificationInbox, repoRoot, reviewAttentionRequest } from "./_helpers";

let server: ChildProcess;
let base: string;
let fixtureHome: string;
const headers = { Authorization: "Bearer attention-fixture-secret" };

for (const width of [1440, 390]) {
  test(`notification menu survives a new chat receiving its URL identity at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    await page.route("**/api/chat/stream", async (route) => {
      entered();
      await gate;
      await route.continue();
    });
    try {
      await page.getByTestId("chat-open-button").click();
      await page.getByTestId("chat-input").fill("Menu identity approval fixture");
      await page.getByTestId("chat-input").press("Enter");
      await blocked;
      await page.locator('[data-testid="notification-bell"]:visible').last().click();
      const menu = notificationInbox(page);
      await expect(menu).toBeVisible();
      release();
      // Desktop keeps the chat URL identity beside the open popover; phones
      // review on the full page, which replaces the chat sheet.
      if (width === 1440)
        await expect.poll(() => new URL(page.url()).searchParams.get("chatThread")).not.toBeNull();
      await expect(menu).toBeVisible();
      const card = menu.locator('[data-testid^="attention-request-"]');
      await expect(card).toHaveCount(1);
      await reviewAttentionRequest(card);
      await card.getByTestId("attention-deny").click();
      await expect(card.getByTestId("attention-response")).toHaveText("Denied");
    } finally {
      release();
    }
  });
}

test.beforeAll(async () => {
  fixtureHome = mkdtempSync(join(tmpdir(), "orc-attention-e2e-"));
  server = spawn("bun", ["packages/web/tests/fixtures/attention-server.ts"], {
    cwd: repoRoot(),
    env: { ...process.env, ORC_ATTENTION_FIXTURE_HOME: fixtureHome },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300000,
  });
  base = await new Promise<string>((resolve, reject) => {
    let output = "";
    let errors = "";
    const timer = setTimeout(() => reject(new Error(`Fixture did not start: ${errors}`)), 20000);
    server.stdout?.on("data", (part) => {
      output += part;
      const url = /ATTENTION_FIXTURE (http:\/\/[^\s]+)/.exec(output)?.[1];
      if (url) {
        clearTimeout(timer);
        resolve(url);
      }
    });
    server.stderr?.on("data", (part) => {
      errors += part;
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Fixture exited ${code}: ${errors}`));
    });
    server.once("error", reject);
  });
  await expect
    .poll(
      async () => {
        try {
          const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
          return response.status;
        } catch {
          return 0;
        }
      },
      { timeout: 10000 },
    )
    .toBe(200);
});
test.afterAll(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Attention fixture did not exit")), 10000);
      server.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      server.kill();
    });
  }
  if (fixtureHome) rmSync(fixtureHome, { recursive: true, force: true });
});
test.beforeEach(async ({ page, request }) => {
  await request.post(`${base}/fixture/observed`, { headers, data: "false" });
  await request.post(`${base}/fixture/other-host`, { headers, data: "false" });
  const history = await (
    await request.get(`${base}/api/notifications?limit=100`, { headers })
  ).json();
  for (const item of history.notifications)
    await request.patch(`${base}/api/notifications/${item.id}`, {
      headers,
      data: { dismissed: true },
    });
  await page.addInitScript(() =>
    localStorage.setItem(
      `orc_api_secret:${new URL("/api", location.href).href}`,
      "attention-fixture-secret",
    ),
  );
  await page.goto(`${base}/activity`);
});

test("a managed approval survives reload, opens its chat and clears after a chat answer", async ({
  page,
}) => {
  await page.getByTestId("chat-open-button").click();
  await page.getByTestId("chat-input").fill("Managed approval fixture");
  await page.getByTestId("chat-input").press("Enter");
  await expect(page.getByTestId("notification-menu")).toHaveCount(0);
  await page.locator('[data-testid="notification-bell"]:visible').last().click();
  const card = page.locator('[data-testid^="attention-request-"]');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Managed approval fixture");
  await page.reload();
  await page.locator('[data-testid="notification-bell"]:visible').last().click();
  await expect(card).toHaveCount(1);
  await reviewAttentionRequest(card);
  await card.getByTestId("attention-open-chat").click();
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await page.getByTestId("chat-panel").getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page.getByTestId("chat-panel")).toContainText("Fixture response: denied");
  await expect(page.getByTestId("notification-menu")).toHaveCount(0);
  await page.locator('[data-testid="notification-bell"]:visible').last().click();
  // The request was marked read when reviewed; its answered card lives in history.
  await page.getByTestId("notifications-show-read").click();
  await reviewAttentionRequest(card);
  await expect(card.getByTestId("attention-response")).toHaveText("Denied");
});

test("an inbox answer clears the original prompt and suppresses its observed duplicate", async ({
  page,
  request,
}) => {
  await page.getByTestId("chat-open-button").click();
  await page.getByTestId("chat-input").fill("Inbox approval fixture");
  await page.getByTestId("chat-input").press("Enter");
  await page.locator('[data-testid="notification-bell"]:visible').last().click();
  const card = page.locator('[data-testid^="attention-request-"]');
  await expect(card).toHaveCount(1);
  await request.post(`${base}/fixture/observed`, { headers, data: "true" });
  await page.reload();
  await page.locator('[data-testid="notification-bell"]:visible').last().click();
  await expect(card).toHaveCount(1);
  await expect(
    page.locator('[data-testid="notification-item"][data-type="agent.question"]'),
  ).toHaveCount(0);
  await reviewAttentionRequest(card);
  await card.getByTestId("attention-deny").click();
  await card.getByTestId("attention-open-chat").click();
  await expect(page.getByTestId("chat-panel")).toContainText("Fixture response: denied");
  await expect(
    page.getByTestId("chat-panel").getByRole("button", { name: "Deny", exact: true }),
  ).toHaveCount(0);
  await request.post(`${base}/fixture/observed`, { headers, data: "false" });
  await expect
    .poll(async () =>
      (await request.get(`${base}/api/notifications`, { headers }))
        .json()
        .then(
          (data) =>
            data.notifications.filter((item: { requires_action: boolean }) => item.requires_action)
              .length,
        ),
    )
    .toBe(0);
});

test("private questions expose only a chat notice and clear after answering", async ({ page }) => {
  await page.getByTestId("chat-open-button").click();
  await page.getByTestId("chat-input").fill("private fixture");
  await page.getByTestId("chat-input").press("Enter");
  await page.locator('[data-testid="notification-bell"]:visible').last().click();
  const card = page.locator('[data-testid="notification-item"][data-type="agent.question"]');
  await expect(card).toHaveCount(1);
  await expect(page.getByTestId("notification-menu")).not.toContainText("Private fixture question");
  await page.getByRole("button", { name: "Close notifications", exact: true }).click();
  await page.getByLabel("Secret: Private fixture question").fill("fixture answer");
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  await expect
    .poll(async () =>
      (await page.request.get(`${base}/api/notifications`, { headers }))
        .json()
        .then(
          (data) =>
            data.notifications.filter((item: { requires_action: boolean }) => item.requires_action)
              .length,
        ),
    )
    .toBe(0);
});

test("a later turn can reuse a backend question ID without losing its new notification", async ({
  page,
}) => {
  await page.getByTestId("chat-open-button").click();
  for (const turn of [1, 2]) {
    await page.getByTestId("chat-input").fill(`private fixture turn ${turn}`);
    await page.getByTestId("chat-input").press("Enter");
    await expect(page.getByLabel("Secret: Private fixture question")).toBeVisible();
    await expect
      .poll(async () => {
        const data = await (
          await page.request.get(`${base}/api/notifications`, { headers })
        ).json();
        return data.notifications.filter(
          (item: { type: string; requires_action: boolean }) =>
            item.type === "agent.question" && item.requires_action,
        ).length;
      })
      .toBe(1);
    await page.getByLabel("Secret: Private fixture question").fill("fixture answer");
    await page.getByRole("button", { name: "Send answer", exact: true }).click();
    await expect(page.getByLabel("Secret: Private fixture question")).toHaveCount(0);
  }
});

test("an observed external question disappears when the session continues", async ({
  page,
  request,
}) => {
  await request.post(`${base}/fixture/observed`, { headers, data: "true" });
  await page.locator('[data-testid="notification-bell"]:visible').last().click();
  const card = page.locator('[data-testid="notification-item"][data-type="agent.question"]');
  await expect(card).toHaveCount(1, { timeout: 20000 });
  await expect(card).toContainText("Observed coding session");
  await expect(card.getByTestId("notification-open")).toBeVisible();
  await request.post(`${base}/fixture/observed`, { headers, data: "false" });
  await expect
    .poll(async () =>
      (await request.get(`${base}/api/notifications`, { headers }))
        .json()
        .then(
          (data) =>
            data.notifications.filter((item: { requires_action: boolean }) => item.requires_action)
              .length,
        ),
    )
    .toBe(0);
});

test("a managed notice cannot hide a question with the same native ID on another host", async ({
  page,
  request,
}) => {
  await page.getByTestId("chat-open-button").click();
  await page.getByTestId("chat-input").fill("Host-specific approval fixture");
  await page.getByTestId("chat-input").press("Enter");
  await page.locator('[data-testid="notification-bell"]:visible').last().click();
  const card = page.locator('[data-testid^="attention-request-"]');
  await expect(card).toHaveCount(1);
  await request.post(`${base}/fixture/other-host`, { headers, data: "true" });
  await page.reload();
  await page.locator('[data-testid="notification-bell"]:visible').last().click();
  await expect(card).toHaveCount(1);
  await expect(
    page.locator('[data-testid="notification-item"][data-type="agent.question"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-testid="notification-item"][data-type="agent.question"]'),
  ).toContainText("fixture-secondary");
  await reviewAttentionRequest(card);
  await page.screenshot({
    path: join(repoRoot(), ".claude/docs/attention-host-visibility.png"),
    fullPage: true,
  });
  await card.getByTestId("attention-deny").click();
  await request.post(`${base}/fixture/other-host`, { headers, data: "false" });
  await expect
    .poll(async () =>
      (await request.get(`${base}/api/notifications`, { headers }))
        .json()
        .then(
          (data) =>
            data.notifications.filter((item: { requires_action: boolean }) => item.requires_action)
              .length,
        ),
    )
    .toBe(0);
});
