import { expect, test } from "@playwright/test";
import { openChatHistory } from "./_chat-ui";
import { API_SECRET } from "./_helpers";

for (const width of [1440, 390]) {
  test(`session rows say why a session waits and when idle work still runs at ${width}px`, async ({
    page,
  }) => {
    const now = Date.now();
    const row = (id: string, name: string, extra: object) => ({
      id,
      session_id: `runtime-${id}`,
      name,
      agent: "claude",
      cwd: "/fixture/run",
      host: null,
      project_id: null,
      task: null,
      model: "claude-opus-5-5",
      created_at: new Date(now - 60_000).toISOString(),
      last_activity_at: new Date(now - 60_000).toISOString(),
      ...extra,
    });
    const sessions = [
      row("waiting", "Session waiting on a permission", {
        status: "running",
        waiting_for_human: true,
        waiting_for: { reason: "permission", tool: "Bash" },
      }),
      row("background", "Session idle with a background shell", {
        status: "idle",
        background_work: true,
      }),
      row("idle", "Session idle", { status: "idle" }),
      row("mcp", "Session waiting on an MCP tool with a long name", {
        status: "running",
        waiting_for_human: true,
        waiting_for: {
          reason: "permission",
          tool: "mcp__claude_ai_ClickUp__clickup_get_bulk_tasks_time_in_status",
        },
      }),
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
    const waiting = list.locator('[data-history-id="native:waiting"]');
    await expect(waiting).toHaveAttribute("data-state", "needs-you");
    await expect(waiting.getByTestId("chat-session-waiting")).toHaveText("permission · Bash");
    const background = list.locator('[data-history-id="native:background"]');
    await expect(background).toHaveAttribute("data-state", "idle");
    await expect(background.getByTestId("chat-session-background")).toHaveAttribute(
      "aria-label",
      "Background work running",
    );
    const mcp = list.locator('[data-history-id="native:mcp"]').getByTestId("chat-session-waiting");
    await expect(mcp).toHaveText("permission · clickup_get_bulk_tasks_time_in_status");
    await expect(mcp).toHaveAttribute(
      "data-label",
      "permission · mcp__claude_ai_ClickUp__clickup_get_bulk_tasks_time_in_status",
    );
    const fit = await list
      .locator('[data-history-id="native:mcp"]')
      .getByTestId("chat-resume-live")
      .evaluate((button) => {
        const row = button.getBoundingClientRect();
        const chip = button
          .querySelector('[data-testid="chat-session-waiting"]')
          ?.getBoundingClientRect();
        const badge = button
          .querySelector('[data-testid="chat-session-status"]')
          ?.getBoundingClientRect();
        return {
          inside: !!chip && chip.right <= row.right && chip.left >= row.left,
          clearOfBadge: !!chip && !!badge && (chip.right <= badge.left || chip.top >= badge.bottom),
        };
      });
    expect(fit).toEqual({ inside: true, clearOfBadge: true });
    const idle = list.locator('[data-history-id="native:idle"]');
    await expect(idle.getByTestId("chat-session-background")).toHaveCount(0);
    await expect(idle.getByTestId("chat-session-waiting")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    if (process.env.ORC_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.ORC_SCREENSHOT_DIR}/session-run-state-${width}.png`,
      });
  });
}
