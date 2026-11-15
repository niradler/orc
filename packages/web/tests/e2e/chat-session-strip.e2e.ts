import { ChatSettingsSchema, type ChatThread } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { HOME, mockSessionHome } from "./_session-home-demo";

// A chat that was never resumed from an agent session has no usage record: the
// header keeps the session facts it knows and omits the context figure entirely.
for (const width of [1440, 390]) {
  test(`chat session strip omits unknown usage at ${width}px`, async ({ page }, testInfo) => {
    const now = Date.now();
    const thread: ChatThread = {
      id: HOME.chatA,
      title: "Round cart totals to cents",
      config: ChatSettingsSchema.parse({ agent: "claude", model: "" }),
      cwd: "/home/demo/acme-shop",
      host: null,
      runtimeId: null,
      sourceId: null,
      backend: "claude-code",
      updatedAt: now - 4 * 60_000,
      messages: [
        {
          id: `${HOME.chatA}-q1`,
          role: "user",
          content: "Cart totals show fractions of a cent. Please round them to cents.",
          timestamp: now - 9 * 60_000,
        },
        {
          id: `${HOME.chatA}-a1`,
          role: "assistant",
          content: "Rounding now happens once at the money boundary in `src/cart/total.ts`.",
          timestamp: now - 4 * 60_000,
          turn: {
            startedAt: now - 6 * 60_000,
            finishedAt: now - 4 * 60_000,
            durationMs: 118_000,
            outcome: "stopped",
          },
        },
      ],
    };
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => localStorage.setItem("orc_theme", "dark"));
    await mockSessionHome(page, now);
    await page.route(`**/api/chat/threads/${HOME.chatA}`, (route) =>
      route.fulfill({ json: thread }),
    );

    await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
    await expect(page.getByTestId("chat-message-content").last()).toContainText("money boundary");

    const strip = page.getByTestId("chat-session-strip");
    await expect(strip).toBeVisible();
    if (width === 1440)
      await expect(page.getByTestId("chat-session-strip-agent")).toContainText("Claude Code");
    await expect(page.getByTestId("chat-session-strip-state")).toHaveAttribute(
      "data-state",
      "idle",
    );
    await expect(page.getByTestId("chat-session-strip-context")).toHaveCount(0);
    await expect(page.getByTestId("chat-session-strip-model")).toHaveCount(0);
    await expect(page.getByTestId("chat-context-help")).toHaveCount(0);

    // No recorded model and no recorded request: absent fields stay absent.
    await expect(page.getByTestId("chat-turn-meta")).toHaveCount(1);
    await expect(page.getByTestId("chat-turn-model")).toHaveCount(0);
    await expect(page.getByTestId("chat-turn-tokens")).toHaveCount(0);
    await expect(page.getByTestId("chat-turn-cache")).toHaveCount(0);
    await expect(page.getByTestId("chat-turn-stop")).toContainText("Stopped");
    await expect(page.getByTestId("chat-message-duration")).toContainText("1m 58s");
    await expect(page.getByTestId("chat-turn-divider-model")).toHaveCount(0);
    await expect(page.getByTestId("chat-turn-divider-compaction")).toHaveCount(0);

    await page.screenshot({
      path: testInfo.outputPath(
        `chat-session-unknown-usage-${width === 1440 ? "desktop" : "phone"}.png`,
      ),
      animations: "disabled",
    });
  });
}

test("chat session strip stays inside a 320px phone", async ({ page }, testInfo) => {
  const now = Date.now();
  const thread: ChatThread = {
    id: HOME.chatA,
    title: "Round cart totals to cents",
    config: ChatSettingsSchema.parse({ agent: "claude", model: "claude-opus-4-1" }),
    cwd: "/home/demo/acme-shop",
    host: null,
    runtimeId: null,
    sourceId: "live-demo-claude",
    backend: "claude-code",
    updatedAt: now - 2 * 60_000,
    messages: [
      {
        id: `${HOME.chatA}-a1`,
        role: "assistant",
        content: "Rounding now happens once at the money boundary in `src/cart/total.ts`.",
        timestamp: now - 2 * 60_000,
        model: "claude-opus-4-1",
        turn: {
          startedAt: now - 3 * 60_000,
          finishedAt: now - 2 * 60_000,
          durationMs: 60_000,
          outcome: "completed",
        },
      },
    ],
  };
  await page.setViewportSize({ width: 320, height: 720 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => localStorage.setItem("orc_theme", "dark"));
  await mockSessionHome(page, now);
  await page.route(`**/api/chat/threads/${HOME.chatA}`, (route) => route.fulfill({ json: thread }));
  await page.route("**/api/sessions/live/live-demo-claude/cache", (route) =>
    route.fulfill({
      json: {
        latest: {
          input_tokens: 48_210,
          cached_input_tokens: 41_120,
          cache_write_tokens: null,
          recorded_at: new Date(now - 2 * 60_000).toISOString(),
          may_be_cold_after: null,
        },
        totals: null,
        output_tokens: null,
        requests: 1,
        compactions: null,
        timeline: null,
      },
    }),
  );

  await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
  const strip = page.getByTestId("chat-session-strip");
  await expect(strip).toBeVisible();
  await expect(page.getByTestId("chat-session-strip-context")).toContainText("cached");
  await expect(page.getByTestId("chat-message-duration")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  const box = await strip.boundingBox();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320);
  await page.screenshot({
    path: testInfo.outputPath("chat-session-strip-320.png"),
    animations: "disabled",
  });
});
