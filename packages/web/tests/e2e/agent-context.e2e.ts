import { ChatSettingsSchema } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { gotoView } from "./_helpers";

const source = [
  "Visible question before context.",
  "<recommended_plugins>",
  'Hidden plugin guidance <img src="https://example.invalid/tracker" onerror="window.contextXss=true">',
  "<nested>Nested guidance</nested>",
  "</recommended_plugins>",
  "Visible answer after context.",
  "<system-reminder>Hidden reminder</system-reminder>",
  "```xml\n<example_context>Code example stays visible</example_context>\n```",
].join("\n");

for (const width of [1440, 390]) {
  test(`agent context is collapsed in chat and session history at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const session = {
      id: "context-fixture",
      session_id: "native-context",
      name: "Context fixture",
      agent: "codex",
      status: "stopped",
      cwd: "/fixture",
      project_id: null,
      last_activity_at: Date.now(),
      tokens_used: null,
    };
    const transcript = {
      turns: [{ index: 0, role: "user", time: null, blocks: [{ type: "text", text: source }] }],
      total: 1,
      matches: [],
    };
    const thread = {
      id: "00000000-0000-4000-8000-000000000222",
      title: "Context fixture",
      config: ChatSettingsSchema.parse({}),
      backend: "codex-cli",
      runtimeId: session.session_id,
      host: null,
      cwd: session.cwd,
      sourceId: session.id,
      messages: [{ id: "context-message", role: "user", content: source, timestamp: Date.now() }],
      updatedAt: Date.now(),
    };
    let trackerRequests = 0;
    page.on("request", (request) => {
      if (request.url().includes("example.invalid/tracker")) trackerRequests++;
    });
    await page.route("**/api/sessions/live?**", (route) =>
      route.fulfill({ json: { sessions: [session] } }),
    );
    await page.route("**/api/sessions/live/context-fixture/transcript?**", (route) =>
      route.fulfill({
        json: {
          ...transcript,
          matches: new URL(route.request().url()).searchParams.has("q") ? [0] : [],
        },
      }),
    );
    await page.route("**/api/chat/threads", (route) => route.fulfill({ json: thread }));
    await gotoView(page, "sessions");
    await page.goto("/sessions?project=all&session=context-fixture");
    const detail = page.getByTestId("live-session-detail");
    const context = detail.locator('[data-testid="agent-context"][data-tag="recommended_plugins"]');
    await expect(context).toBeVisible();
    await expect(context.getByTestId("agent-context-content")).toBeHidden();
    await expect(detail).toContainText("Visible question before context.");
    await expect(detail).toContainText("Visible answer after context.");
    await context.locator("summary").press("Enter");
    await expect(context.getByTestId("agent-context-content")).toBeVisible();
    await expect(context).toContainText("<nested>Nested guidance</nested>");
    await expect(context.locator("img")).toHaveCount(0);
    await context.locator("summary").click();
    await detail.getByTestId("transcript-search").fill("Hidden plugin guidance");
    await expect(context.getByTestId("agent-context-content")).toBeVisible();
    await detail.getByTestId("resume-actions-menu").click();
    await page.getByTestId("resume-actions-dropdown").getByTestId("open-chat-resume").click();
    const message = page.getByTestId("chat-message-content").filter({ visible: true });
    await expect(message.getByTestId("agent-context")).toHaveCount(2);
    const panel = message.locator('[data-tag="recommended_plugins"]');
    await expect(panel.getByTestId("agent-context-content")).toBeHidden();
    await expect(message).toContainText("Code example stays visible");
    await panel.locator("summary").click();
    await expect(panel.getByTestId("agent-context-content")).toBeVisible();
    await expect(panel.getByTestId("agent-context-content")).toContainText(
      "Hidden plugin guidance",
    );
    await panel.locator("summary").click();
    await expect(panel.getByTestId("agent-context-content")).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath(`agent-context-${width}.png`) });
    await page.route("**/api/sessions/archive?**", (route) =>
      route.fulfill({
        json: {
          sessions: [
            {
              id: "archive-context",
              agent: "claude",
              native_id: "archive-native",
              title: "Archived context",
              revision: 1,
              updated_at: new Date().toISOString(),
              metadata: { cwd: "/fixture", subdirectory: "" },
              passages: [],
            },
          ],
          total: 1,
          has_more: false,
        },
      }),
    );
    await page.route("**/api/sessions/archive/archive-context/transcript?**", (route) =>
      route.fulfill({ json: transcript }),
    );
    await gotoView(page, "sessions");
    await page.getByTestId("archive-disclosure").locator("summary").click();
    await page.getByTestId("archive-session-row").click();
    const archive = page.getByTestId("archive-detail");
    const archivedContext = archive.locator(
      '[data-testid="agent-context"][data-tag="recommended_plugins"]',
    );
    await expect(archivedContext.getByTestId("agent-context-content")).toBeHidden();
    await archivedContext.locator("summary").click();
    await expect(archivedContext.getByTestId("agent-context-content")).toBeVisible();
    expect(trackerRequests).toBe(0);
    expect(await page.evaluate(() => "contextXss" in window)).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
