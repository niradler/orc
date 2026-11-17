import { expect, test } from "@playwright/test";
import { apiPost, gotoView, tid } from "./_helpers";

/** Seed a session via the MCP session_log tool and return the created session id. */
async function seedSession(
  request: Parameters<typeof apiPost>[0],
  agent: string,
  summary: string,
): Promise<string> {
  const { result } = await apiPost<{ result: string }>(request, "/mcp/tool", {
    name: "session_log",
    args: { agent, summary },
  });
  // result = "Session logged: <ulid>"
  return result.replace("Session logged: ", "").trim();
}

test.describe("Sessions", () => {
  test("native session date order persists and reverses the whole result list", async ({
    page,
  }) => {
    // Other tests in the shard share this API database, so give these rows a
    // unique token and search on it instead of the shared date prefix.
    const tag = tid("date-order");
    const dates = ["2026-02-01", "2026-01-01", "2026-03-01"];
    await page.route("**/api/sessions/live?*", (route) =>
      route.fulfill({
        json: {
          sessions: dates.map((date, index) => ({
            id: `date-${index}`,
            session_id: `native-${index}`,
            agent: "codex",
            name: `${date} ${tag}`,
            status: "idle",
            project_id: null,
            task: null,
            handoff: null,
            last_activity_at: new Date(date).toISOString(),
            created_at: new Date(date).toISOString(),
            tokens_used: 0,
            tokens_estimated: false,
            cwd: null,
          })),
        },
      }),
    );
    await gotoView(page, "sessions");
    await page.getByTestId("chat-session-search").fill(tag);
    const rows = page.getByTestId("chat-session-list").getByTestId("chat-history-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText("2026-03-01");
    await page.getByTestId("chat-session-sort").selectOption("active-asc");
    await expect(rows.first()).toContainText("2026-01-01");
    await page.reload();
    await expect(page.getByTestId("chat-session-sort")).toHaveValue("active-asc");
    await expect(rows.first()).toContainText("2026-01-01");
  });

  test("Audit date order persists and resets pagination", async ({ page, request }) => {
    const agent = tid("date-sort");
    for (let i = 0; i < 26; i++) await seedSession(request, agent, `Date order ${i}`);
    await gotoView(page, "activity");
    await page.goto(`/audit?project=all&agent=${agent}`);
    await page.getByTestId("pager-next").click();
    await expect(page.getByTestId("pager")).toContainText("Page 2");
    await page.getByTestId("audit-date-sort").selectOption("asc");
    await expect(page.getByTestId("pager")).toContainText("Page 1");
    await page.reload();
    await expect(page.getByTestId("audit-date-sort")).toHaveValue("asc");
    await expect(page.getByTestId("logged-sessions")).toBeVisible();
  });
  test("Audit opens directly and preserves shared state", async ({ page }) => {
    await gotoView(page, "activity");
    await page.goto("/audit?project=all#records");
    await expect(page).toHaveURL(/\/audit\?project=all#records$/);
    await expect(page.getByTestId("logged-sessions")).toBeVisible();
    await expect(page.getByTestId("nav-audit")).toHaveAttribute("aria-current", "page");
  });
  test("session seeded via MCP tool appears in list", async ({ page, request }) => {
    const agent = tid("pw-agent");
    const summary = `Playwright test session ${agent}`;
    const sessionId = await seedSession(request, agent, summary);

    await gotoView(page, "activity");
    await page.getByTestId("nav-audit").click();
    await page.getByTestId("audit-session-history").locator("summary").click();
    await expect(page.getByTestId("view-title")).toHaveText("Audit");

    const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(agent);
  });

  test("clicking a session row opens detail sheet", async ({ page, request }) => {
    const agent = tid("pw-agent-detail");
    const sessionId = await seedSession(request, agent, `Detail test ${agent}`);

    await gotoView(page, "activity");
    await page.getByTestId("nav-audit").click();
    await page.getByTestId("audit-session-history").locator("summary").click();

    const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`);
    await expect(row).toBeVisible();
    await row.click();

    // Sheet renders as a dialog in shadcn/ui
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    // Agent name should appear in the sheet header
    await expect(sheet).toContainText(agent);
    await expect(sheet).not.toContainText("Invalid Date");
    await expect(sheet).toContainText("audit record");
  });

  test("seeded session appears in sessions list", async ({ page, request }) => {
    const agent = tid("pw-agent-count");
    const sessionId = await seedSession(request, agent, `Count test ${agent}`);

    await gotoView(page, "activity");
    await page.getByTestId("nav-audit").click();
    await page.getByTestId("audit-session-history").locator("summary").click();
    await expect(page.getByTestId("view-title")).toHaveText("Audit");

    const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(agent);
  });

  test("Audit follows Jobs and is separate from the chat session list", async ({ page }) => {
    await gotoView(page, "sessions");
    await expect(page.getByTestId("chat-session-sidebar")).toBeVisible();
    await expect(page.getByTestId("logged-sessions")).toHaveCount(0);
    await page.getByTestId("nav-activity").click();
    await expect(page.locator('nav[aria-label="Activity pages"] a')).toHaveText([
      "Activity",
      "Jobs",
      "Webhooks",
      "Audit",
    ]);

    await page.getByTestId("nav-audit").click();
    await page.getByTestId("audit-session-history").locator("summary").click();
    await expect(page.getByTestId("logged-sessions")).toBeVisible();
    await expect(page.getByTestId("chat-session-sidebar")).toHaveCount(0);
    await expect(page).toHaveURL(/\/audit/);
    await page.reload();
    await expect(page.getByTestId("view-title")).toHaveText("Audit");
  });

  test("ORC sessions paginate", async ({ page, request }) => {
    const agent = tid("pw-agent-page");
    for (let i = 0; i < 26; i++) {
      await seedSession(request, agent, `Pagination test ${agent} ${i}`);
    }

    await gotoView(page, "activity");
    await page.getByTestId("nav-audit").click();
    await expect(page.getByTestId("session-row")).toHaveCount(25);
    await page.getByTestId("audit-session-history").locator("summary").click();

    await page.getByTestId("pager-next").click();
    await expect(page.getByTestId("pager")).toContainText("Page 2");
    await expect(page.getByTestId("session-row").first()).toBeVisible();

    await page.getByTestId("pager-prev").click();
    await expect(page.getByTestId("pager")).toContainText("Page 1");
  });
});
