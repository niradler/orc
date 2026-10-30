import { ChatSettingsSchema, type ChatThread } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { captureState } from "./_capture-state";
import { closeChatHistory, openChatActions, openChatHistory, openChatSettings } from "./_chat-ui";
import { API_SECRET } from "./_helpers";

for (const width of [1440, 390]) {
  test(`session provider identity, resume context and responsive header at ${width}px`, async ({
    page,
  }, testInfo) => {
    const now = Date.now();
    const saved: ChatThread = {
      id: "80000000-0000-4000-8000-000000000001",
      title: "Cursor on build host",
      config: ChatSettingsSchema.parse({ agent: "cursor", model: "fixture-model" }),
      cwd: "/fixture/cursor",
      host: "build-host",
      runtimeId: "cursor-runtime",
      sourceId: null,
      backend: "cursor-cli",
      updatedAt: now - 2000,
      messages: [],
    };
    const resumed: ChatThread = {
      ...saved,
      id: "80000000-0000-4000-8000-000000000002",
      title: "Claude remote session",
      config: ChatSettingsSchema.parse({ agent: "claude", model: "fixture-claude" }),
      cwd: "/fixture/claude",
      host: "claude-host",
      runtimeId: "claude-runtime",
      sourceId: "native-claude",
      backend: "claude-cli",
      updatedAt: now - 1000,
    };
    let resumeCalls = 0;
    let savedReads = 0;
    await page.addInitScript(
      (secret) =>
        localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
      API_SECRET,
    );
    await page.route("**/api/chat/models?**", (route) =>
      route.fulfill({ json: { models: [], warning: null } }),
    );
    await page.route("**/api/chat/threads", async (route) => {
      if (route.request().method() === "POST") {
        expect(route.request().postDataJSON()).toEqual({ sourceSessionId: "native-claude" });
        resumeCalls++;
        await route.fulfill({ json: resumed });
      } else
        await route.fulfill({
          json: {
            threads: [
              {
                id: saved.id,
                title: saved.title,
                agent: "cursor",
                running: false,
                updatedAt: saved.updatedAt,
              },
            ],
          },
        });
    });
    await page.route(`**/api/chat/threads/${saved.id}`, (route) => {
      savedReads++;
      return route.fulfill({ json: saved });
    });
    await page.route("**/api/chat/threads/*/live", (route) =>
      route.fulfill({ status: 204, body: "" }),
    );
    await page.route("**/api/sessions/archive?**", (route) =>
      route.fulfill({ json: { sessions: [], has_more: false } }),
    );
    await page.route("**/api/sessions/live?**", (route) =>
      route.fulfill({
        json: {
          sessions: [
            {
              id: "native-claude",
              session_id: "claude-runtime",
              agent: "claude",
              name: resumed.title,
              host: resumed.host,
              cwd: resumed.cwd,
              status: "stopped",
              last_activity_at: new Date(now - 1000).toISOString(),
              created_at: new Date(now - 1000).toISOString(),
            },
            {
              id: "native-codex",
              session_id: "codex-runtime",
              agent: "codex",
              name: "Working Codex",
              host: null,
              cwd: "/fixture/codex",
              status: "running",
              last_activity_at: new Date(now).toISOString(),
              created_at: new Date(now).toISOString(),
            },
          ],
          has_more: false,
        },
      }),
    );
    await page.request.patch("/api/settings", {
      headers: { Authorization: `Bearer ${API_SECRET}` },
      data: { theme: "dark" },
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/tasks?chat=full");
    await page.getByTestId("chat-input").fill("Keep my unsent local draft");
    await openChatHistory(page);
    const list = page.getByTestId("chat-session-list");
    await expect(list.locator('[data-history-id="native:native-codex"]')).toHaveAttribute(
      "data-state",
      "running",
    );
    for (const provider of ["codex", "claude", "cursor"]) {
      const icon = list
        .locator(`[data-testid="chat-session-provider"][data-provider="${provider}"]`)
        .first();
      await expect(icon).toBeVisible();
      const mask = await icon.evaluate((el) => getComputedStyle(el).maskImage);
      expect(mask).toContain(`/assets/${provider}-`);
      const assetURL = mask.replace(/^url\(["']?/, "").replace(/["']?\)$/, "");
      const asset = await page.request.get(assetURL);
      expect(asset.ok()).toBe(true);
      expect(await asset.text()).toContain("<svg");
    }
    await expect(list.locator("details,summary,h2,h3")).toHaveCount(0);
    await captureState(page, {
      path: testInfo.outputPath(`session-history-providers-${width}.png`),
      animations: "disabled",
    });
    await expect(
      page
        .getByRole("button", { name: "New session", exact: true })
        .filter({ visible: true })
        .last(),
    ).toBeVisible();
    await list
      .locator(`[data-history-id="chat:${saved.id}"]`)
      .getByTestId("chat-resume-thread")
      .click();
    await closeChatHistory(page);
    await expect(page.getByTestId("chat-agent-button")).toContainText("cursor");
    await expect(page.getByTestId("chat-model-button")).toContainText("fixture-model");
    expect(savedReads).toBe(1);
    await openChatSettings(page);
    await expect(page.getByTestId("chat-config-dialog")).toContainText("build-host");
    await expect(page.getByTestId("chat-config-dialog")).toContainText(saved.cwd);
    await page.getByTestId("chat-agent-options").locator("summary").click();
    await page.getByTestId("chat-agent-options-input").fill('["--keep-unsaved-on-resize"]');
    await page.setViewportSize({ width: width === 1440 ? 390 : 1440, height: 844 });
    await expect(page.getByTestId("chat-config-dialog")).toBeVisible();
    await expect(page.getByTestId("chat-config-dialog")).toHaveCount(1);
    await expect(page.getByTestId("chat-agent-options-input")).toHaveValue(
      '["--keep-unsaved-on-resize"]',
    );
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByTestId("chat-agent-options-input")).toHaveValue(
      '["--keep-unsaved-on-resize"]',
    );

    await page.keyboard.press("Escape");
    if (width === 1440) {
      await expect(page.getByTestId("chat-header-actions")).toBeVisible();
      await expect(page.getByTestId("chat-options-button")).toHaveCount(0);
      await expect(page.getByTestId("chat-refresh-button")).toBeVisible();
    } else {
      if (await page.getByRole("dialog", { name: "Session actions", exact: true }).isVisible())
        await page.keyboard.press("Escape");
      await expect(page.getByTestId("chat-options-button")).toBeVisible();
    }
    await openChatHistory(page);
    await list
      .locator('[data-history-id="native:native-claude"]')
      .getByTestId("chat-resume-live")
      .click();
    await closeChatHistory(page);
    expect(resumeCalls).toBe(1);
    await expect(page.getByTestId("chat-model-button")).toContainText("fixture-claude");
    await expect(page.getByTestId("chat-agent-button")).toContainText("claude");
    await openChatSettings(page);
    await expect(page.getByTestId("chat-config-dialog")).toContainText("claude-host");
    await expect(page.getByTestId("chat-config-dialog")).toContainText(resumed.cwd);
    await page.keyboard.press("Escape");
    if (await page.getByRole("dialog", { name: "Session actions", exact: true }).isVisible())
      await page.keyboard.press("Escape");
    if (width === 390) {
      await openChatActions(page);
      await expect(page.getByTestId("chat-continue-terminal")).toBeVisible();
      await captureState(page, {
        path: testInfo.outputPath("session-actions-more-390.png"),
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
    }
    await openChatHistory(page);
    const draft = list.locator('[data-history-id^="draft:"]');
    await draft.getByTestId("chat-session-select").click();
    await closeChatHistory(page);
    await expect(page.getByTestId("chat-input")).toHaveValue("Keep my unsent local draft");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await captureState(page, {
      path: testInfo.outputPath(`session-controls-${width}.png`),
      animations: "disabled",
    });
    if (width === 1440) {
      await page.getByTestId("chat-close-button").click();
      await page.getByTestId("theme-toggle").click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await page.getByTestId("chat-open-button").click();
      await page.getByTestId("chat-fullscreen-button").filter({ visible: true }).click();
      await expect(page.getByTestId("chat-session-sidebar")).toBeVisible();
      await expect(page.getByTestId("chat-header-actions")).toBeVisible();
      await expect
        .poll(async () => (await page.getByTestId("chat-panel").boundingBox())?.width ?? 0)
        .toBeGreaterThan(1000);
      await expect(page.getByTestId("chat-input")).toHaveValue("Keep my unsent local draft");
      await captureState(page, {
        path: testInfo.outputPath("session-controls-light-1440.png"),
        animations: "disabled",
      });
      await page.getByTestId("chat-close-button").click();
      await page.getByTestId("theme-toggle").click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    }
  });
}
