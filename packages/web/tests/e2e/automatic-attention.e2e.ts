import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { repoRoot, reviewAttentionRequest } from "./_helpers";

let server: ChildProcess;
let base: string;
const headers = { Authorization: "Bearer attention-fixture-secret" };
test.beforeAll(async () => {
  server = spawn("bun", ["packages/web/tests/fixtures/attention-server.ts"], {
    cwd: repoRoot(),
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
});
test.afterAll(() => {
  server?.kill();
});
test.beforeEach(async ({ page, request }) => {
  await request.post(`${base}/fixture/observed`, { headers, data: "false" });
  await request.post(`${base}/fixture/other-host`, { headers, data: "false" });
  await page.addInitScript(() =>
    localStorage.setItem(
      `orc_api_secret:${new URL("/api", location.href).href}`,
      "attention-fixture-secret",
    ),
  );
  await page.goto(`${base}/attention`);
});

test("a managed approval survives reload, opens its chat and clears after a chat answer", async ({
  page,
}) => {
  await page.getByTestId("chat-open-button").click();
  await page.getByTestId("chat-input").fill("Managed approval fixture");
  await page.getByTestId("chat-input").press("Enter");
  const card = page.locator('[data-testid^="attention-request-"]');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Managed approval fixture");
  await page.reload();
  await expect(card).toHaveCount(1);
  await reviewAttentionRequest(card);
  await card.getByTestId("attention-open-chat").click();
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await page.getByTestId("chat-panel").getByRole("button", { name: "Deny", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("attention-empty")).toBeVisible();
  await expect(page.getByTestId("chat-panel")).toContainText("Fixture response: denied");
});

test("an inbox answer clears the original prompt and suppresses its observed duplicate", async ({
  page,
  request,
}) => {
  await page.getByTestId("chat-open-button").click();
  await page.getByTestId("chat-input").fill("Inbox approval fixture");
  await page.getByTestId("chat-input").press("Enter");
  const card = page.locator('[data-testid^="attention-request-"]');
  await expect(card).toHaveCount(1);
  await request.post(`${base}/fixture/observed`, { headers, data: "true" });
  await page.reload();
  await expect(card).toHaveCount(1);
  await expect(page.locator('[data-testid^="attention-session-"]')).toHaveCount(0);
  await reviewAttentionRequest(card);
  await card.getByTestId("attention-open-chat").click();
  await card.getByTestId("attention-deny").click();
  await expect(page.getByTestId("chat-panel")).toContainText("Fixture response: denied");
  await expect(
    page.getByTestId("chat-panel").getByRole("button", { name: "Deny", exact: true }),
  ).toHaveCount(0);
  await expect(card).toHaveCount(0);
  await request.post(`${base}/fixture/observed`, { headers, data: "false" });
  await expect(page.getByTestId("attention-empty")).toBeVisible();
});

test("private questions expose only a chat notice and clear after answering", async ({ page }) => {
  await page.getByTestId("chat-open-button").click();
  await page.getByTestId("chat-input").fill("private fixture");
  await page.getByTestId("chat-input").press("Enter");
  const card = page.locator('[data-testid^="attention-chat-"]');
  await expect(card).toHaveCount(1);
  await expect(page.getByTestId("attention-view")).not.toContainText("Private fixture question");
  await expect(page.locator('[data-testid^="attention-request-"]')).toHaveCount(0);
  await page.getByLabel("Secret: Private fixture question").fill("fixture answer");
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("attention-empty")).toBeVisible();
});

test("an observed external question disappears when the session continues", async ({
  page,
  request,
}) => {
  await request.post(`${base}/fixture/observed`, { headers, data: "true" });
  const card = page.locator('[data-testid^="attention-session-"]');
  await expect(card).toHaveCount(1, { timeout: 20000 });
  await expect(card).toContainText("Observed coding session");
  await expect(card.getByRole("button", { name: "View session" })).toBeVisible();
  await request.post(`${base}/fixture/observed`, { headers, data: "false" });
  await expect(card).toHaveCount(0, { timeout: 20000 });
  await expect(page.getByTestId("attention-empty")).toBeVisible();
});

test("a managed notice cannot hide a question with the same native ID on another host", async ({
  page,
  request,
}) => {
  await page.getByTestId("chat-open-button").click();
  await page.getByTestId("chat-input").fill("Host-specific approval fixture");
  await page.getByTestId("chat-input").press("Enter");
  const card = page.locator('[data-testid^="attention-request-"]');
  await expect(card).toHaveCount(1);
  await request.post(`${base}/fixture/other-host`, { headers, data: "true" });
  await page.reload();
  await expect(card).toHaveCount(1);
  await expect(page.locator('[data-testid^="attention-session-"]')).toHaveCount(1);
  await expect(page.locator('[data-testid^="attention-session-"]')).toContainText(
    "fixture-secondary",
  );
  await reviewAttentionRequest(card);
  await page.screenshot({
    path: join(repoRoot(), ".claude/docs/attention-host-visibility.png"),
    fullPage: true,
  });
  await card.getByTestId("attention-deny").click();
  await request.post(`${base}/fixture/other-host`, { headers, data: "false" });
  await expect(page.getByTestId("attention-empty")).toBeVisible();
});
