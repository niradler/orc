import { spawnSync } from "node:child_process";
import { ChatSettingsSchema } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { API_SECRET, repoRoot } from "./_helpers";

const headers = { Authorization: `Bearer ${API_SECRET}` };
const defaults = ChatSettingsSchema.parse({});

test.beforeEach(async ({ page, request }) => {
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await request.patch("/api/settings", { headers, data: { chat: defaults } });
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as unknown as { __copied?: string }).__copied = text;
        },
      },
    });
  });
});

function seedThread(id: string, title: string) {
  const started = Date.now() - 120_000;
  const thread = {
    id,
    title,
    config: defaults,
    cwd: "/tmp",
    host: null,
    runtimeId: null,
    backend: "codex-cli",
    sourceId: null,
    updatedAt: started + 42_000,
    messages: [
      {
        id: crypto.randomUUID(),
        role: "user",
        content: "Refactor the chat scroll",
        timestamp: started,
      },
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "Refactor finished: the panel now follows only while pinned.",
        timestamp: started + 42_000,
        agent: "codex",
        turn: {
          startedAt: started,
          finishedAt: started + 42_000,
          durationMs: 42_000,
          outcome: "completed",
        },
      },
    ],
  };
  const seed = spawnSync(
    "bun",
    [
      "-e",
      'import {getSqlite} from "./packages/db/src/client.ts";import {ChatStore} from "./packages/db/src/chat.ts";new ChatStore(getSqlite()).save(JSON.parse(process.argv[1]));',
      JSON.stringify(thread),
    ],
    { cwd: repoRoot(), env: process.env, encoding: "utf8", timeout: 10000 },
  );
  expect(seed.status, seed.stderr).toBe(0);
}

for (const width of [1440, 390]) {
  test(`assistant turns show duration, copy and fork at ${width}px`, async ({ page }) => {
    const id = crypto.randomUUID();
    const title = "Refactor the checkout totals";
    seedThread(id, title);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/tasks?chat=open&chatThread=${id}`);

    const assistant = page.locator('[data-testid="chat-message"][data-role="assistant"]');
    await expect(assistant).toHaveCount(1);
    const duration = assistant.getByTestId("chat-message-duration");
    await expect(duration).toHaveText("42s");
    await expect(duration).toHaveAttribute("title", /Worked for 42s, ended/);

    const copy = assistant.getByTestId("chat-message-copy");
    const fork = assistant.getByTestId("chat-message-fork");
    await assistant.hover();
    await expect(copy).toBeVisible();
    await copy.click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __copied?: string }).__copied))
      .toBe("Refactor finished: the panel now follows only while pinned.");
    await expect(copy).toHaveAccessibleName("Copied");
    await page.screenshot({ path: test.info().outputPath(`message-actions-${width}.png`) });

    await fork.click();
    await expect.poll(() => new URL(page.url()).searchParams.get("chatThread")).not.toBe(id);
    const forked = new URL(page.url()).searchParams.get("chatThread");
    expect(forked).not.toBeNull();
    await expect(page.getByTestId("chat-message")).toHaveCount(2);
    await expect(page.getByTestId("chat-message-duration")).toHaveText("42s");
    await expect(page.getByText(`${title} (fork)`)).toBeVisible();
    await expect(page.getByTestId("chat-message-action-error")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath(`message-actions-fork-${width}.png`) });
  });
}
