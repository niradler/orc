import { expect, test } from "@playwright/test";
import { openChatHistory } from "./_chat-ui";
import { API_SECRET } from "./_helpers";

for (const width of [1440, 390]) {
  test(`a live session row shows its model and permission mode at ${width}px`, async ({ page }) => {
    const now = Date.now();
    const row = (id: string, name: string, extra: object) => ({
      id,
      session_id: `runtime-${id}`,
      name,
      agent: "claude",
      status: "stopped",
      cwd: "/fixture/run",
      host: null,
      project_id: null,
      task: null,
      created_at: new Date(now - 60_000).toISOString(),
      last_activity_at: new Date(now - 60_000).toISOString(),
      ...extra,
    });
    const sessions = [
      row("with-run", "Session with model", {
        model: "claude-opus-5-5",
        permission_mode: "acceptEdits",
      }),
      row("long-run", "Session with a long model name", {
        model: "anthropic/claude-opus-5-5-with-a-very-long-provider-specific-model-identifier",
        permission_mode: "bypassPermissions",
      }),
      row("without-run", "Session without model", { model: null, permission_mode: null }),
      row("child", "Explore subagent", { parent_id: "with-run", model: "claude-haiku-5" }),
    ];
    await page.addInitScript((secret) => {
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
    }, API_SECRET);
    await page.route("**/api/chat/models?**", (route) =>
      route.fulfill({ json: { models: [], warning: null } }),
    );
    await page.route("**/api/chat/threads", (route) => route.fulfill({ json: { threads: [] } }));
    await page.route("**/api/sessions/live?**", (route) =>
      route.fulfill({ json: { sessions, has_more: false } }),
    );
    await page.route("**/api/sessions/archive?**", (route) =>
      route.fulfill({ json: { sessions: [], has_more: false } }),
    );
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/tasks?chat=full");
    await openChatHistory(page);
    const list = page.getByTestId("chat-session-list");
    const withRun = list.locator('[data-history-id="native:with-run"]');
    await expect(withRun.getByTestId("chat-session-run")).toContainText(
      "claude-opus-5-5 · Allow edits",
    );
    await expect(withRun.getByTestId("chat-session-status")).toBeVisible();
    await expect(list.locator('[data-history-id="native:without-run"]')).toBeVisible();
    await expect(
      list.locator('[data-history-id="native:without-run"]').getByTestId("chat-session-run"),
    ).toHaveCount(0);

    const longRun = list
      .locator('[data-history-id="native:long-run"]')
      .getByTestId("chat-session-run");
    await expect(longRun).toContainText("Full access");
    const clipped = await longRun.evaluate((el) => {
      const box = el.closest(".truncate") as HTMLElement;
      return {
        right: box.getBoundingClientRect().right,
        truncated: box.scrollWidth > box.clientWidth,
      };
    });
    expect(clipped.truncated).toBe(true);
    expect(clipped.right).toBeLessThanOrEqual(width);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    const rowButton = withRun.getByTestId("chat-resume-live");
    await expect(rowButton.getByTestId("chat-session-subagent-count")).toHaveText("1 subagent");
    await expect(
      list
        .locator('[data-history-id="native:without-run"]')
        .getByTestId("chat-session-subagent-count"),
    ).toHaveCount(0);
    if (width < 640)
      expect((await rowButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    if (process.env.ORC_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.ORC_SCREENSHOT_DIR}/session-row-run-${width}.png`,
      });
  });
}
