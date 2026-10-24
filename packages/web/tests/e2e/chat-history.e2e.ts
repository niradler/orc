import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRegistration } from "@orc/core/live-session";
import { expect, test } from "@playwright/test";
import { apiGet, apiPost, gotoView } from "./_helpers";

for (const width of [1440, 390]) {
  test(`500-turn native history pages, continues and reopens at ${width}px`, async ({
    page,
    request,
  }) => {
    const cwd = mkdtempSync(join(tmpdir(), "orc-chat-history-"));
    const externalId = crypto.randomUUID();
    const transcript = join(cwd, "history.jsonl");
    writeFileSync(
      transcript,
      Array.from({ length: 1105 }, (_, index) =>
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: index % 2 ? "assistant" : "user",
            content: [
              { type: index % 2 ? "output_text" : "input_text", text: `History turn ${index}.` },
            ],
          },
        }),
      ).join("\n"),
    );
    writeRegistration({
      backend: "codex",
      externalId,
      pid: process.pid,
      title: `Large history ${externalId}`,
      cwd,
      transcriptPath: transcript,
      status: "stopped",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await apiPost(request, "/sessions/live/sync", {});
    const live = await apiGet<{ sessions: { id: string; session_id: string }[] }>(
      request,
      "/sessions/live?active=false",
    );
    const source = live.sessions.find((item) => item.session_id === externalId);
    expect(source).toBeDefined();
    await page.setViewportSize({ width, height: 900 });
    await gotoView(page, "sessions");
    await page.goto(`/sessions?project=all&session=${source?.id}`);
    const prepared = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/chat/threads") && response.request().method() === "POST",
    );
    await page.getByTestId("live-session-detail").getByTestId("resume-actions-menu").click();
    await page.getByTestId("resume-actions-dropdown").getByTestId("open-chat-resume").click();
    const thread = await (await prepared).json();
    expect(thread.historyBefore).toBe(605);
    await expect(page.getByTestId("chat-message")).toHaveCount(500);
    await expect(page.getByTestId("chat-panel")).not.toContainText("Resumed native session.");
    const viewport = page.getByTestId("chat-messages").filter({ visible: true });
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
    });
    const anchor = page
      .getByTestId("chat-message-content")
      .filter({ hasText: /^History turn 605\.$/ });
    await expect(anchor).toBeInViewport();
    await page.getByTestId("chat-load-older").filter({ visible: true }).click();
    await expect(page.getByTestId("chat-message")).toHaveCount(1000);
    await expect(anchor).toBeInViewport();
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.getByTestId("chat-load-older").filter({ visible: true }).click();
    await expect(page.getByTestId("chat-message")).toHaveCount(1105);
    await expect(page.getByTestId("chat-load-older")).toHaveCount(0);
    await page
      .getByTestId("chat-input")
      .filter({ visible: true })
      .fill("Continue after importing 500 turns");
    await page.getByTestId("chat-send-button").filter({ visible: true }).click();
    await expect(page.getByTestId("chat-message")).toHaveCount(1107);
    const saved = await apiGet<{ messages: unknown[] }>(request, `/chat/threads/${thread.id}`);
    expect(saved.messages).toHaveLength(502);
    await page.reload();
    await page.getByTestId("chat-sessions-button").filter({ visible: true }).click();
    await page
      .getByTestId("chat-resume-thread")
      .filter({ hasText: `Large history ${externalId}` })
      .click();
    await expect(page.getByTestId("chat-message")).toHaveCount(502);
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(page.getByTestId("chat-load-older").filter({ visible: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
