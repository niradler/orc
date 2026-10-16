import { expect, test } from "@playwright/test";
import { API_SECRET } from "./_helpers";

test("stopping a chunked response preserves partial text and a new send finishes independently", async ({
  page,
}, testInfo) => {
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    let intercepted = false;
    window.fetch = (input, init) => {
      if (!String(input).endsWith("/chat/stream") || intercepted) return original(input, init);
      intercepted = true;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              const bytes = encoder.encode('data: {"type":"text","text":"Partial response ✓"}\n\n');
              const split = bytes.indexOf(0xe2) + 1;
              controller.enqueue(bytes.slice(0, split));
              controller.enqueue(bytes.slice(split));
              init?.signal?.addEventListener("abort", () =>
                controller.error(new DOMException("Aborted", "AbortError")),
              );
              Object.assign(window, {
                releaseCancelledChat: () => {
                  try {
                    controller.enqueue(
                      encoder.encode('data: {"type":"text","text":"STALE-LATE-CHUNK"}\n\n'),
                    );
                    controller.close();
                  } catch {
                    /* Aborted stream correctly refuses late chunks. */
                  }
                },
              });
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    };
  });
  await page.goto("/tasks");
  await page.getByTestId("chat-open-button").click();
  await page.getByTestId("chat-input").fill("Start a chunked response");
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByTestId("chat-message-content").last()).toContainText("Partial response ✓");
  await page.getByTestId("chat-agent-select").selectOption("claude");
  await expect(page.getByRole("status").filter({ hasText: "codex is responding" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("chat-loading-partial.png") });
  await page.getByTestId("chat-cancel-button").click();
  await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "false");
  await page.evaluate(() =>
    (window as unknown as { releaseCancelledChat: () => void }).releaseCancelledChat(),
  );
  await expect(page.locator('[data-testid="chat-message"][data-role="assistant"]')).toHaveCount(1);
  await expect(page.getByTestId("chat-messages")).not.toContainText("STALE-LATE-CHUNK");
  await page.getByTestId("chat-input").fill("Reply with exactly: NEXT-REQUEST-OK.");
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByTestId("chat-message-content").last()).toContainText("NEXT-REQUEST-OK");
  await expect(page.locator('[data-testid="chat-message"][data-role="assistant"]')).toHaveCount(2);
});

test("clearing a pending chat cannot append stale output and preferences survive reload", async ({
  page,
}) => {
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let finishFirst: () => void = () => {};
  const firstFinished = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  let requests = 0;
  const requestedAgents: string[] = [];
  await page.route("**/api/chat/stream", async (route) => {
    requestedAgents.push(route.request().postDataJSON().agent);
    const first = ++requests === 1;
    if (first) await firstGate;
    await route
      .fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ type: "text", text: first ? "stale response" : "fresh response" })}\n\ndata: {"type":"done"}\n\n`,
      })
      .catch(() => {});
    if (first) finishFirst();
  });
  await page.goto("/tasks");
  await page.getByTestId("chat-open-button").click();
  const panel = page.getByTestId("chat-panel");
  await expect(panel.getByTestId("chat-agent-select")).toHaveValue("codex");
  await panel.getByTestId("chat-input").fill("First request");
  await panel.getByTestId("chat-send-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "true");
  await expect.poll(() => requests).toBe(1);
  await panel.getByTestId("chat-clear-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "false");
  await panel.getByTestId("chat-agent-select").selectOption("claude");
  await panel.getByTestId("chat-input").fill("Second request");
  await panel.getByTestId("chat-send-button").click();
  await expect(panel.getByTestId("chat-message-content").last()).toContainText("fresh response");
  releaseFirst();
  await firstFinished;
  await expect(panel.getByTestId("chat-message")).toHaveCount(2);
  await expect(panel).not.toContainText("stale response");
  expect(requestedAgents).toEqual(["codex", "claude"]);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = page.getByTestId("mobile-chat-sheet");
  await expect(mobile.getByTestId("chat-message-content").last()).toContainText("fresh response");
  await mobile.getByLabel("Close chat", { exact: true }).click();
  await page.getByTestId("chat-open-button").click();
  await expect(mobile.getByTestId("chat-message")).toHaveCount(2);
  await page.reload();
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await expect(page.getByTestId("mobile-chat-sheet").getByTestId("chat-agent-select")).toHaveValue(
    "claude",
  );
});

for (const theme of ["dark", "light"] as const) {
  for (const width of [1440, 390, 320]) {
    test(`chat page keeps agent meaning, keyboard composition and errors usable ${theme}/${width}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.request.patch("/api/settings", {
        headers: { Authorization: `Bearer ${API_SECRET}` },
        data: { theme },
      });
      await page.addInitScript(
        ({ secret, theme }) => {
          localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
          localStorage.setItem("orc_theme", theme);
        },
        { secret: API_SECRET, theme },
      );
      let count = 0;
      await page.route("**/api/chat/stream", async (route) => {
        count++;
        if (count === 3) {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: "Selected agent is unavailable. Check its connection and try again.",
            }),
          });
          return;
        }
        const agent = route.request().postDataJSON().agent;
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: `data: ${JSON.stringify({ type: "text", text: `Response from ${agent}` })}\n\ndata: {"type":"done"}\n\n`,
        });
      });
      await page.goto("/tasks");
      await page.getByTestId("chat-open-button").click();
      const panel = page.getByTestId("chat-panel");
      const picker = panel.getByTestId("chat-agent-select");
      await expect(picker).toHaveValue("codex");
      expect((await picker.boundingBox())?.y).toBeLessThan(180);
      await page.screenshot({ path: testInfo.outputPath(`chat-${theme}-${width}-empty.png`) });
      const input = panel.getByTestId("chat-input");
      await input.fill("First line");
      await input.press("Shift+Enter");
      await input.press("A");
      await expect(input).toHaveValue("First line\nA");
      await panel.getByTestId("chat-send-button").click();
      await expect(panel.getByTestId("chat-message-content").last()).toContainText(
        "Response from codex",
      );
      await picker.selectOption("claude");
      await expect(
        panel.locator('[data-role="assistant"]').first().getByTestId("chat-message-agent"),
      ).toHaveText("codex");
      await input.fill("Second request");
      await input.press("Enter");
      await expect(panel.getByTestId("chat-message-content").last()).toContainText(
        "Response from claude",
      );
      await expect(
        panel.locator('[data-role="assistant"]').last().getByTestId("chat-message-agent"),
      ).toHaveText("claude");
      await page.screenshot({ path: testInfo.outputPath(`chat-${theme}-${width}-populated.png`) });
      await input.fill("Error request");
      await panel.getByTestId("chat-send-button").click();
      await expect(panel.getByTestId("chat-error")).toContainText("Selected agent is unavailable");
      await expect(input).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath(`chat-${theme}-${width}-error.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      await page.reload();
      await expect(page.getByTestId("chat-panel")).toBeVisible();
      await expect(page.getByTestId("chat-agent-select")).toHaveValue("claude");
    });
  }
}
