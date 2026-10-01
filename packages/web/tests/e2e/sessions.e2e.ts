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
  test("session seeded via MCP tool appears in list", async ({ page, request }) => {
    const agent = tid("pw-agent");
    const summary = `Playwright test session ${agent}`;
    const sessionId = await seedSession(request, agent, summary);

    await gotoView(page, "sessions");
    await page.getByTestId("sessions-orc-tab").click();
    await expect(page.getByTestId("view-title")).toHaveText(/sessions/i);

    const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(agent);
  });

  test("clicking a session row opens detail sheet", async ({ page, request }) => {
    const agent = tid("pw-agent-detail");
    const sessionId = await seedSession(request, agent, `Detail test ${agent}`);

    await gotoView(page, "sessions");
    await page.getByTestId("sessions-orc-tab").click();

    const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`);
    await expect(row).toBeVisible();
    await row.click();

    // Sheet renders as a dialog in shadcn/ui
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    // Agent name should appear in the sheet header
    await expect(sheet).toContainText(agent);
  });

  test("seeded session appears in sessions list", async ({ page, request }) => {
    const agent = tid("pw-agent-count");
    const sessionId = await seedSession(request, agent, `Count test ${agent}`);

    await gotoView(page, "sessions");
    await page.getByTestId("sessions-orc-tab").click();
    await expect(page.getByTestId("view-title")).toHaveText(/sessions/i);

    const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(agent);
  });

  test("agent sessions and ORC sessions are separate tabs", async ({ page }) => {
    await gotoView(page, "sessions");
    await expect(page.getByTestId("live-sessions")).toBeVisible();
    await expect(page.getByTestId("logged-sessions")).toHaveCount(0);

    await page.getByTestId("sessions-orc-tab").click();
    await expect(page.getByTestId("logged-sessions")).toBeVisible();
    await expect(page.getByTestId("live-sessions")).toHaveCount(0);
  });

  test("ORC sessions paginate", async ({ page, request }) => {
    const agent = tid("pw-agent-page");
    for (let i = 0; i < 26; i++) {
      await seedSession(request, agent, `Pagination test ${agent} ${i}`);
    }

    await gotoView(page, "sessions");
    await page.getByTestId("sessions-orc-tab").click();
    await expect(page.getByTestId("session-row")).toHaveCount(25);

    await page.getByTestId("pager-next").click();
    await expect(page.getByTestId("pager")).toContainText("Page 2");
    await expect(page.getByTestId("session-row").first()).toBeVisible();

    await page.getByTestId("pager-prev").click();
    await expect(page.getByTestId("pager")).toContainText("Page 1");
  });
});
