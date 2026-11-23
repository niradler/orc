import { ChatSettingsSchema, type ChatThread } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { settingsSection } from "./_chat-ui";
import { API_SECRET, toggleThemeInPlace } from "./_helpers";
import { HOME, mockSessionHome } from "./_session-home-demo";

const CAPTURE_DIR = process.env.ORC_CAPTURE_541_DIR ?? "";

function buildThread(now: number): ChatThread {
  return {
    id: HOME.chatA,
    title: "Refactor checkout rounding",
    config: ChatSettingsSchema.parse({
      agent: "claude",
      model: "claude-opus-4-1",
      permissionMode: "acceptEdits",
    }),
    cwd: "/home/demo/acme-shop",
    host: null,
    runtimeId: "6c1f0d8e-4a51-4a76-9b7f-2e1a3f5e9b21",
    sourceId: "live-demo-claude",
    backend: "claude-code",
    projectId: "proj-shop",
    updatedAt: now - 5 * 60_000,
    messages: [
      {
        id: `${HOME.chatA}-u1`,
        role: "user",
        content: "Audit the cart rounding logic.",
        timestamp: now - 32 * 60_000,
      },
      {
        id: `${HOME.chatA}-a1`,
        role: "assistant",
        content: "Found the floating-point drift in subtotal calculation.",
        timestamp: now - 28 * 60_000,
        model: "claude-sonnet-4-5",
        turn: {
          startedAt: now - 30 * 60_000,
          finishedAt: now - 28 * 60_000,
          durationMs: 120_000,
          outcome: "completed",
        },
      },
      {
        id: `${HOME.chatA}-u2`,
        role: "user",
        content: "Switch to Opus and write the fix plus tests.",
        timestamp: now - 18 * 60_000,
      },
      {
        id: `${HOME.chatA}-a2`,
        role: "assistant",
        content: "Applied the rounding fix and verified every cart test passes.",
        timestamp: now - 12 * 60_000,
        model: "claude-opus-4-1",
        turn: {
          startedAt: now - 16 * 60_000,
          finishedAt: now - 12 * 60_000,
          durationMs: 240_000,
          outcome: "completed",
        },
      },
    ],
  };
}

function buildAnalytics(now: number) {
  return {
    messages: 6,
    userMessages: 3,
    assistantMessages: 3,
    turns: 3,
    toolCalls: 6,
    toolFailures: 1,
    attachments: 0,
    startedAt: now - 32 * 60_000,
    lastActivityAt: now - 5 * 60_000,
    outcomes: { completed: 3, stopped: 0, interrupted: 0, failed: 0, running: 0 },
    durations: { averageMs: 140_000, medianMs: 120_000, p95Ms: 240_000, totalMs: 420_000 },
    toolTotal: 2,
    skills: [{ name: "orc-sdlc", loads: 1 }],
    tools: [
      { name: "Read", calls: 4, failures: 0 },
      { name: "Bash", calls: 2, failures: 1 },
    ],
    turnTimeline: [
      {
        index: 1,
        startedAt: now - 30 * 60_000,
        durationMs: 120_000,
        outcome: "completed",
        toolCalls: 2,
        toolFailures: 0,
        responseChars: 180,
        model: "claude-sonnet-4-5",
        usage: {
          input: 12_000,
          output: 4_500,
          cacheRead: 64_000,
          cacheWrite: 3_000,
          reasoning: 500,
          total: 84_000,
        },
        costUsd: 0.14145,
        usageSource: "recorded",
      },
      {
        index: 2,
        startedAt: now - 16 * 60_000,
        durationMs: 240_000,
        outcome: "completed",
        toolCalls: 3,
        toolFailures: 1,
        responseChars: 240,
        model: "claude-opus-4-1",
        usage: {
          input: 10_000,
          output: 6_000,
          cacheRead: 80_000,
          cacheWrite: 2_000,
          reasoning: 1_000,
          total: 99_000,
        },
        costUsd: 0.8325,
        usageSource: "recorded",
      },
      {
        index: 3,
        startedAt: now - 8 * 60_000,
        durationMs: 60_000,
        outcome: "completed",
        toolCalls: 1,
        toolFailures: 0,
        responseChars: 95,
        model: "acme/custom-local-v1",
        usage: {
          input: 4_000,
          output: 1_200,
          cacheRead: 12_000,
          cacheWrite: 0,
          reasoning: 0,
          total: 17_200,
        },
        costUsd: null,
        usageSource: "recorded",
      },
    ],
    turnTimelineTruncated: false,
    usage: {
      totals: {
        input: 26_000,
        output: 11_700,
        cacheRead: 156_000,
        cacheWrite: 5_000,
        reasoning: 1_500,
        total: 200_200,
      },
      attributed: {
        input: 26_000,
        output: 11_700,
        cacheRead: 156_000,
        cacheWrite: 5_000,
        reasoning: 1_500,
        total: 200_200,
      },
      unattributed: null,
      unattributedRequests: 0,
      cacheHitRate: 156_000 / (26_000 + 156_000 + 5_000),
      cacheSavingsUsd: 1.2435,
      totalCostUsd: 0.97395,
      costComplete: false,
      usageSource: "recorded",
      byModel: [
        {
          model: "claude-opus-4-1",
          turns: 1,
          requests: 3,
          usage: {
            input: 10_000,
            output: 6_000,
            cacheRead: 80_000,
            cacheWrite: 2_000,
            reasoning: 1_000,
            total: 99_000,
          },
          costUsd: 0.8325,
          cacheHitRate: 80_000 / 92_000,
          cacheSavingsUsd: 1.0725,
          usageSource: "recorded",
        },
        {
          model: "claude-sonnet-4-5",
          turns: 1,
          requests: 2,
          usage: {
            input: 12_000,
            output: 4_500,
            cacheRead: 64_000,
            cacheWrite: 3_000,
            reasoning: 500,
            total: 84_000,
          },
          costUsd: 0.14145,
          cacheHitRate: 64_000 / 79_000,
          cacheSavingsUsd: 0.171,
          usageSource: "recorded",
        },
        {
          model: "acme/custom-local-v1",
          turns: 1,
          requests: 1,
          usage: {
            input: 4_000,
            output: 1_200,
            cacheRead: 12_000,
            cacheWrite: 0,
            reasoning: 0,
            total: 17_200,
          },
          costUsd: null,
          cacheHitRate: 12_000 / 16_000,
          cacheSavingsUsd: null,
          usageSource: "recorded",
        },
      ],
    },
    context: {
      backend: "claude",
      model: "claude-opus-4-1",
      supported: true,
      reason: null,
      usage: {
        latest: {
          input_tokens: 48_000,
          cached_input_tokens: 40_000,
          cache_write_tokens: 2_000,
          recorded_at: new Date(now - 5 * 60_000).toISOString(),
          may_be_cold_after: null,
          context_tokens: 48_000,
          context_window: 200_000,
        },
        totals: {
          input_tokens: 187_000,
          cached_input_tokens: 156_000,
          cache_write_tokens: 5_000,
        },
        output_tokens: 13_200,
        requests: 6,
        compactions: [],
        timeline: [
          {
            request: 1,
            recorded_at: new Date(now - 30 * 60_000).toISOString(),
            context_tokens: 24_000,
            cached_input_tokens: 18_000,
            output_tokens: 2_000,
          },
          {
            request: 2,
            recorded_at: new Date(now - 16 * 60_000).toISOString(),
            context_tokens: 48_000,
            cached_input_tokens: 40_000,
            output_tokens: 4_000,
          },
        ],
      },
    },
  };
}

for (const viewport of [
  { width: 1440, height: 900, label: "desktop" },
  { width: 390, height: 844, label: "phone" },
]) {
  test(`session analytics per-turn usage, model split and unpriced help at ${viewport.label}`, async ({
    page,
  }) => {
    const now = Date.now();
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => {
      localStorage.setItem("orc_theme", "dark");
    });
    await mockSessionHome(page, now);
    await page.route(`**/api/chat/threads/${HOME.chatA}`, (route) =>
      route.fulfill({ json: buildThread(now) }),
    );
    await page.route(`**/api/chat/threads/${HOME.chatA}/analytics`, (route) =>
      route.fulfill({ json: buildAnalytics(now) }),
    );

    await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
    const dividerLink = page.getByTestId("chat-turn-divider-model-link");
    await expect(dividerLink).toBeVisible();
    await expect(dividerLink).toContainText("claude-opus-4-1");
    await dividerLink.click();

    const dialog = page.getByTestId("chat-analytics-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("chat-analytics-total-tokens")).toContainText("200k");
    await expect(dialog.getByTestId("chat-analytics-cache-hit-rate")).toContainText("83.4%");
    await expect(dialog.getByTestId("chat-analytics-cache-savings")).toContainText("$1.24");
    await expect(dialog.getByTestId("chat-analytics-total-cost")).toContainText("$0.97+");

    const modelSplit = dialog.getByTestId("chat-analytics-model-split");
    await expect(modelSplit).toBeVisible();
    await expect(modelSplit).toContainText("claude-opus-4-1");
    await expect(modelSplit).toContainText("claude-sonnet-4-5");
    await expect(modelSplit).toContainText("acme/custom-local-v1");

    const tokensChart = dialog.getByTestId("chat-turn-tokens-chart");
    await tokensChart.scrollIntoViewIfNeeded();
    await expect(tokensChart).toBeVisible();
    await expect(tokensChart).toContainText("Input");
    await expect(tokensChart).toContainText("Output");
    await expect(tokensChart).toContainText("Cache read");
    await expect(tokensChart).toContainText("Cache write");

    if (viewport.width >= 640) {
      const table = dialog.getByTestId("chat-turn-table");
      await expect(table).toBeVisible();
      await expect(table.getByTestId("chat-turn-row")).toHaveCount(3);
      await expect(table.getByTestId("chat-turn-row").nth(2)).toContainText("-");
      const unpricedHelp = table.getByTestId("chat-turn-unpriced-3");
      await unpricedHelp.click();
      await expect(page.getByTestId("chat-turn-unpriced-3-content")).toContainText(
        "No price configured for this model. Add one in Settings -> Usage.",
      );
      await unpricedHelp.click();
    } else {
      const mobileList = dialog.getByTestId("chat-turn-list-mobile");
      await expect(mobileList).toBeVisible();
      await expect(mobileList.getByTestId("chat-turn-row-mobile")).toHaveCount(3);
      await expect(mobileList.getByTestId("chat-turn-row-mobile").nth(2)).toContainText("-");
      const unpricedHelp = mobileList.getByTestId("chat-turn-unpriced-mobile-3");
      await unpricedHelp.click();
      await expect(page.getByTestId("chat-turn-unpriced-mobile-3-content")).toContainText(
        "No price configured for this model. Add one in Settings -> Usage.",
      );
      await unpricedHelp.click();
    }

    const overflow = await dialog.evaluate((node) => ({
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);

    if (CAPTURE_DIR) {
      await dialog.evaluate((node) => {
        node.scrollTop = 0;
      });
      await page.waitForTimeout(150);
      await page.screenshot({
        path: `${CAPTURE_DIR}/orc-541-${viewport.label}.png`,
        animations: "disabled",
      });
      await tokensChart.scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      await page.screenshot({
        path: `${CAPTURE_DIR}/orc-541-${viewport.label}-turns.png`,
        animations: "disabled",
      });
    }

    await toggleThemeInPlace(page);
    const lightOverflow = await dialog.evaluate((node) => ({
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    }));
    expect(lightOverflow.scrollWidth).toBeLessThanOrEqual(lightOverflow.clientWidth + 1);
  });
}

test("model pricing override editor in Settings -> Usage saves custom rates", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addInitScript((secret) => {
    localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
    localStorage.setItem("orc_theme", "dark");
  }, API_SECRET);
  let savedPricing: Record<string, unknown> = {};
  await page.route("**/api/usage/report?*", (route) =>
    route.fulfill({
      json: {
        days: 30,
        since: new Date().toISOString(),
        granularity: "day",
        filters: { agent: null, model: null },
        totals: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          other_tokens: 0,
          total_tokens: 0,
          requests: 0,
          sessions: 0,
          estimated_requests: 0,
        },
        agents: [],
        models: [],
        buckets: [],
        coverage: {
          indexed_sessions: 0,
          unindexed_sessions: 0,
          unindexed_tokens: 0,
          unknown_sessions: 0,
          unsupported_sessions: 0,
          estimated_sessions: 0,
        },
      },
    }),
  );
  await page.route("**/api/usage/quotas", (route) => route.fulfill({ json: { accounts: [] } }));
  await page.route(/\/api\/settings$/, async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { model_pricing?: Record<string, unknown> };
      savedPricing = body.model_pricing ?? {};
      await route.fulfill({ json: { model_pricing: savedPricing } });
      return;
    }
    await route.fulfill({ json: { model_pricing: savedPricing } });
  });

  await page.goto("/settings");
  await settingsSection(page, "usage");
  const pricing = page.getByTestId("usage-model-pricing");
  await pricing.locator("summary").first().click();
  await page.getByTestId("usage-pricing-add").click();
  await page.getByTestId("usage-pricing-model-input").fill("acme/custom-local-v1");
  await page.getByTestId("usage-pricing-input-rate").fill("2");
  await page.getByTestId("usage-pricing-output-rate").fill("8");
  await page.getByTestId("usage-pricing-cache-read-rate").fill("0.2");
  await page.getByTestId("usage-pricing-cache-write-rate").fill("2.5");
  await page.getByTestId("usage-pricing-save").click();

  const row = page.getByTestId("usage-pricing-override-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("acme/custom-local-v1");
  await expect(row).toContainText("In $2");
  const section = page.getByTestId("settings-usage");
  expect(await section.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
});
