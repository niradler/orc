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
    await expect(page.getByTestId("view-title")).toHaveText(/sessions/i);

    const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(agent);
  });

  test("clicking a session row opens detail sheet", async ({ page, request }) => {
    const agent = tid("pw-agent-detail");
    const sessionId = await seedSession(request, agent, `Detail test ${agent}`);

    await gotoView(page, "sessions");

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
    await expect(page.getByTestId("view-title")).toHaveText(/sessions/i);

    const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(agent);
  });
});
