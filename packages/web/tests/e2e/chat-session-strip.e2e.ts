import { ChatSettingsSchema, type ChatThread } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { HOME, mockSessionHome } from "./_session-home-demo";

// A chat that was never resumed from an agent session has no usage record: the
// header shows only the state, and the turn footer omits the figures it lacks.
for (const width of [1440, 390]) {
  test(`chat header omits unknown usage at ${width}px`, async ({ page }, testInfo) => {
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

    await expect(page.getByTestId("chat-header-state").filter({ visible: true })).toHaveAttribute(
      "data-state",
      "idle",
    );
    await expect(page.getByTestId("chat-session-strip")).toHaveCount(0);

    // No recorded model and no recorded request: absent fields stay absent.
    await expect(page.getByTestId("chat-turn-meta")).toHaveCount(1);
    await expect(page.getByTestId("chat-turn-model")).toHaveCount(0);
    await expect(page.getByTestId("chat-turn-tokens")).toHaveCount(0);
    await expect(page.getByTestId("chat-turn-cache")).toHaveCount(0);
    await expect(page.getByTestId("chat-turn-stop")).toContainText("Stopped");
    await expect(page.getByTestId("chat-message-duration")).toContainText("1m 58s");
    await expect(page.getByTestId("chat-turn-divider-model")).toHaveCount(0);
    await expect(page.getByTestId("chat-turn-divider-compaction")).toHaveCount(0);
    await expect(page.getByTestId("chat-context-meter")).toHaveCount(0);

    await page.screenshot({
      path: testInfo.outputPath(
        `chat-session-unknown-usage-${width === 1440 ? "desktop" : "phone"}.png`,
      ),
      animations: "disabled",
    });
  });
}

test("chat header state stays inside a 320px phone", async ({ page }, testInfo) => {
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
  const state = page.getByTestId("chat-header-state").filter({ visible: true });
  await expect(state).toBeVisible();
  await expect(page.getByTestId("chat-turn-cache")).toContainText("cached");
  await expect(page.getByTestId("chat-message-duration")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  const box = await state.boundingBox();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320);
  await page.screenshot({
    path: testInfo.outputPath("chat-header-state-320.png"),
    animations: "disabled",
  });
});

const meterCases = [
  {
    name: "unknown",
    popover: "48k tokens",
    context: 48_210,
    window: null,
    label: "48k",
    tone: "unknown",
  },
  {
    name: "ring",
    popover: "48k / 200k · 24%",
    context: 48_210,
    window: 200_000,
    label: "24%",
    tone: "series-1",
  },
  {
    name: "full",
    popover: "178k / 200k · 89%",
    context: 178_400,
    window: 200_000,
    label: "89%",
    tone: "warning",
  },
] as const;

for (const width of [1440, 390])
  for (const meterCase of meterCases)
    test(`chat composer shows the ${meterCase.name} context meter at ${width}px`, async ({
      page,
    }, testInfo) => {
      const now = Date.now();
      const at = (minutes: number) => now - minutes * 60_000;
      const suffix = width === 1440 ? "desktop" : "phone";
      const thread: ChatThread = {
        id: HOME.chatA,
        title: "Round cart totals to cents",
        config: ChatSettingsSchema.parse({ agent: "claude", model: "claude-opus-4-1" }),
        cwd: "/home/demo/acme-shop",
        host: null,
        runtimeId: null,
        sourceId: "live-demo-claude",
        backend: "claude-code",
        updatedAt: at(1),
        messages: [
          { id: "q1", role: "user", content: "Round cart totals to cents.", timestamp: at(30) },
          {
            id: "a1",
            role: "assistant",
            content: "Rounding now happens once at the money boundary.",
            timestamp: at(25),
            turn: { startedAt: at(29), finishedAt: at(25), outcome: "completed" },
          },
          { id: "q3", role: "user", content: "Add a test for refunds.", timestamp: at(10) },
          {
            id: "a3",
            role: "assistant",
            content: "Added `refund.test.ts` covering partial refunds.",
            timestamp: at(5),
            turn: { startedAt: at(9), finishedAt: at(5), outcome: "completed" },
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
      await page.route("**/api/sessions/live/live-demo-claude/cache", (route) =>
        route.fulfill({
          json: {
            latest: {
              input_tokens: 48_210,
              cached_input_tokens: 41_120,
              cache_write_tokens: null,
              recorded_at: new Date(at(5)).toISOString(),
              may_be_cold_after: null,
              context_tokens: meterCase.context,
              context_window: meterCase.window,
            },
            totals: null,
            output_tokens: null,
            requests: 12,
            compactions: [
              {
                recorded_at: new Date(at(12)).toISOString(),
                pre_tokens: 182_000,
                post_tokens: 24_000,
                trigger: "auto",
              },
            ],
            timeline: null,
          },
        }),
      );

      await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
      await expect(page.getByTestId("chat-message-content").last()).toContainText("refund.test.ts");

      const meter = page.getByTestId("chat-context-meter");
      await expect(meter).toHaveText(meterCase.label);
      await expect(meter).toHaveAttribute("data-tone", meterCase.tone);
      await expect(page.getByTestId("chat-context-ring")).toHaveCount(meterCase.window ? 1 : 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
      await page.screenshot({
        path: testInfo.outputPath(`chat-context-meter-${meterCase.name}-${suffix}.png`),
        animations: "disabled",
      });
      await meter.click();
      const popover = page.getByTestId("chat-context-meter-popover");
      await expect(popover).toHaveText(
        [
          meterCase.popover,
          ...(meterCase.tone === "warning" ? ["Compact or start a new chat"] : []),
          "1 compaction",
        ].join(""),
      );
      await expect(page.getByTestId("chat-context-meter-warning")).toHaveCount(
        meterCase.tone === "warning" ? 1 : 0,
      );
      await page.screenshot({
        path: testInfo.outputPath(`chat-context-meter-${meterCase.name}-open-${suffix}.png`),
        animations: "disabled",
      });
    });

test("chat context meter keeps the last reported window after a turn without usage", async ({
  page,
}) => {
  const now = Date.now();
  const at = (minutes: number) => now - minutes * 60_000;
  const thread: ChatThread = {
    id: HOME.chatA,
    title: "Round cart totals to cents",
    config: ChatSettingsSchema.parse({ agent: "claude", model: "claude-opus-4-1" }),
    cwd: "/home/demo/acme-shop",
    host: null,
    runtimeId: null,
    sourceId: "live-demo-claude",
    backend: "claude-code",
    updatedAt: at(1),
    messages: [
      { id: "q1", role: "user", content: "Round cart totals to cents.", timestamp: at(30) },
      {
        id: "a1",
        role: "assistant",
        content: "Rounding now happens once at the money boundary.",
        timestamp: at(25),
        turn: {
          startedAt: at(29),
          finishedAt: at(25),
          outcome: "completed",
          usage: {
            input_tokens: 170_000,
            cached_input_tokens: 160_000,
            context_tokens: 170_000,
            context_window: 200_000,
          },
        },
      },
      { id: "q2", role: "user", content: "Add a test for refunds.", timestamp: at(10) },
      {
        id: "a2",
        role: "assistant",
        content: "The response failed.",
        timestamp: at(5),
        turn: { startedAt: at(9), finishedAt: at(5), outcome: "failed" },
      },
    ],
  };
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockSessionHome(page, now);
  await page.route(`**/api/chat/threads/${HOME.chatA}`, (route) => route.fulfill({ json: thread }));
  await page.route("**/api/sessions/live/live-demo-claude/cache", (route) =>
    route.fulfill({
      json: {
        latest: {
          input_tokens: 178_400,
          cached_input_tokens: 170_000,
          cache_write_tokens: null,
          recorded_at: new Date(at(6)).toISOString(),
          may_be_cold_after: null,
          context_tokens: 178_400,
          context_window: null,
        },
        totals: null,
        output_tokens: null,
        requests: 2,
        compactions: null,
        timeline: null,
      },
    }),
  );

  await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
  await expect(page.getByTestId("chat-message-content").last()).toContainText("failed");
  const meter = page.getByTestId("chat-context-meter");
  await expect(meter).toHaveText("89%");
  await expect(meter).toHaveAttribute("data-tone", "warning");
  await expect(page.getByTestId("chat-context-ring")).toHaveCount(1);
});
