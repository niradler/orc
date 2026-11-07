import { expect, test } from "@playwright/test";
import { openFinalFormStep, revealFormField } from "./_form-ui";
import {
  API_SECRET,
  apiDelete,
  apiGet,
  apiPost,
  gotoView,
  reviewAttentionRequest,
  tid,
} from "./_helpers";
import { test as terminalTest } from "./_terminal-fixture";

const ask = (marker: string) =>
  `Reply with exactly: ${marker}. Do not include any other words, punctuation, quotes, or whitespace around it.`;

async function seedSession(
  request: Parameters<typeof apiPost>[0],
  agent: string,
  summary: string,
): Promise<string> {
  const { result } = await apiPost<{ result: string }>(request, "/mcp/tool", {
    name: "session_log",
    args: { agent, summary },
  });
  return result.replace("Session logged: ", "").trim();
}

test.describe("@sanity critical flows", () => {
  test("the app loads, accepts the dev secret, and renders the main pages", async ({ page }) => {
    await gotoView(page, "dashboard");
    await expect(page.getByTestId("view-title")).toHaveText(/activity/i);
    await expect(page.getByTestId("stat-card").first()).toBeVisible();
    await gotoView(page, "projects");
    await expect(page.getByTestId("view-title")).toHaveText(/projects/i);
    await gotoView(page, "sessions");
    await expect(page.getByTestId("live-sessions")).toBeVisible();
  });

  test("a chat message streams an assistant reply", async ({ page }) => {
    await page.addInitScript(
      (secret) =>
        localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
      API_SECRET,
    );
    await page.goto("/");
    const panel = page.getByTestId("chat-panel");
    const openButton = page.getByTestId("chat-open-button");
    await expect(panel.or(openButton).first()).toBeVisible();
    if (!(await panel.isVisible())) await openButton.click();
    const marker = "PW-SANITY-OK";
    const input = page.getByTestId("chat-input");
    await input.fill(ask(marker));
    await input.press("Enter");
    await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 45_000 });
    await expect(
      page
        .locator(
          "[data-testid='chat-message'][data-role='assistant'] [data-testid='chat-message-content']",
        )
        .last(),
    ).toContainText(marker);
  });

  test("the session list opens a seeded session", async ({ page, request }) => {
    const agent = tid("sanity-session");
    const sessionId = await seedSession(request, agent, `Sanity session ${agent}`);
    await gotoView(page, "sessions");
    await expect(page.getByTestId("live-sessions")).toBeVisible();
    await page.getByTestId("nav-audit").click();
    await page.getByTestId("audit-session-history").locator("summary").click();
    const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`);
    await expect(row).toBeVisible();
    await row.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText(agent);
  });

  test("a permission prompt can be approved", async ({ page, request }) => {
    const approval = await apiPost<{ id: string }>(request, "/human-requests", {
      kind: "approval",
      prompt: "Allow this read-only command?",
      origin: { backend: "claude", session_id: tid("sanity-approval"), request_id: "approval" },
      action: { tool: "Bash", input: { command: "pwd" }, cwd: "/workspace", host: "demo-host" },
    });
    await gotoView(page, "attention");
    const card = page.getByTestId(`attention-request-${approval.id}`);
    await reviewAttentionRequest(card);
    await card.getByTestId("attention-approve").click();
    await expect(card.getByTestId("attention-response")).toHaveText("Approved");
  });

  test("a job can be created and run", async ({ page, request }) => {
    const name = tid("sanity-job");
    await gotoView(page, "jobs");
    await page.getByTestId("new-job-button").click();
    await revealFormField(page, page.getByTestId("job-name-input"));
    await page.getByTestId("job-name-input").fill(name);
    await revealFormField(page, page.getByTestId("job-command-input"));
    await page.getByTestId("job-command-input").fill("echo sanity");
    await openFinalFormStep(page);
    await page.getByTestId("job-submit").click();
    const row = page.locator(`[data-testid="job-row"][data-job-name="${name}"]`);
    await expect(row).toBeVisible();
    const id = await row.getAttribute("data-job-id");
    expect(id).toBeTruthy();
    try {
      await row.getByTestId("job-trigger").click();
      await expect
        .poll(async () => {
          const result = await apiGet<{ runs: { status: string }[] }>(request, `/jobs/${id}/runs`);
          return result.runs.some((run) => run.status === "success");
        })
        .toBe(true);
    } finally {
      if (id) await apiDelete(request, `/jobs/${id}`);
    }
  });

  test("a knowledge base can be created and searched", async ({ page, request }) => {
    const name = tid("sanity-kb");
    const needle = tid("sanityneedle");
    try {
      await gotoView(page, "knowledge");
      await page.getByTestId("kb-create").click();
      await page.getByTestId("kb-name-input").fill(name);
      await page.getByTestId("kb-create-submit").click();
      await expect(page.getByTestId("kb-overview-name")).toHaveText(name);
      await page.getByTestId("kb-new-document").click();
      await page.getByTestId("kb-doc-title-input").fill("Sanity note");
      await page.getByTestId("kb-doc-content-input").fill(`Look for ${needle} in this note.`);
      await page.getByTestId("kb-doc-create-submit").click();
      await expect(page.getByTestId("kb-document-title")).toHaveText("Sanity note");
      await page.getByTestId("kb-search-input").fill(needle);
      await page.getByTestId("kb-search-submit").click();
      await expect(page.getByTestId("kb-search-result").first()).toContainText("Sanity note");
    } finally {
      try {
        const listed = await apiGet<{ knowledge_bases: { id: string; name: string }[] }>(
          request,
          "/kb/bases?scope=all",
        );
        const created = listed.knowledge_bases.find((base) => base.name === name);
        if (created) await apiDelete(request, `/kb/bases/${created.id}`);
      } catch (error) {
        console.error(error);
      }
    }
  });

  test.describe("phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("navigation opens and reaches knowledge", async ({ page }) => {
      await gotoView(page, "dashboard");
      await page.getByTestId("mobile-nav-open").click();
      const drawer = page.getByTestId("mobile-nav-drawer");
      await expect(drawer).toBeVisible();
      await drawer.getByTestId("nav-knowledge").click();
      await expect(page.getByTestId("view-title")).toHaveText(/knowledge/i);
    });
  });
});

terminalTest("@sanity a terminal opens", async ({ page, request }) => {
  const terminal = await apiPost<{ id: string }>(request, "/terminals", {
    kind: "shell",
    host: null,
  });
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.goto(`/terminals/${terminal.id}?project=all`);
  await expect(page.getByTestId("terminal-viewport")).toBeVisible();
});
