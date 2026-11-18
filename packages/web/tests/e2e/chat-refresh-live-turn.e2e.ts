import { ChatSettingsSchema, type ChatThread } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { openChatActions } from "./_chat-ui";
import { API_SECRET } from "./_helpers";

declare global {
  interface Window {
    liveRefreshTest: {
      state: { posts: number; attaches: number; opened: number };
      log: { t: number; kind: string; value?: string }[];
      finish(): void;
    };
  }
}

// Regression (review P2): refreshing a chat that is mid-turn must keep reading as
// "working" while the reattach is pending, even if the separate session query is
// still cached idle (running:false / no live claim). Clearing the known-live
// stream on refresh would flicker the header to idle, enable fork and hide Stop
// until /live opens. The idle-rebuild fix must not reintroduce that.
test("refreshing a live turn keeps working while reattach is pending", async ({ page }) => {
  const threadId = "92000000-0000-4000-8000-000000000001";
  const thread: ChatThread = {
    id: threadId,
    title: "Live turn refresh",
    config: ChatSettingsSchema.parse({ agent: "codex" }),
    backend: "codex-cli",
    runtimeId: "live-refresh-native",
    sourceId: null,
    cwd: "/fixture",
    host: null,
    messages: [{ id: "user", role: "user", content: "Long run", timestamp: Date.now() }],
    updatedAt: Date.now(),
  };
  await page.addInitScript(
    ({ thread, secret }) => {
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
      const original = window.fetch.bind(window);
      const encoder = new TextEncoder();
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const state = { posts: 0, attaches: 0, opened: 0 };
      // Record every data-streaming transition so a flicker too brief to catch
      // with a retrying assertion is still observable (as in chat-idle-rebuild).
      const log: { t: number; kind: string; value?: string }[] = [];
      const note = (kind: string, value?: string) =>
        log.push({ t: Math.round(performance.now()), kind, value });
      const watchPanel = () => {
        const read = () =>
          document.querySelector('[data-testid="chat-panel"]')?.getAttribute("data-streaming") ??
          "absent";
        let last = read();
        note("panel", last);
        new MutationObserver(() => {
          const now = read();
          if (now !== last) {
            last = now;
            note("panel", now);
          }
        }).observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["data-streaming"],
        });
      };
      if (document.body) watchPanel();
      else document.addEventListener("DOMContentLoaded", watchPanel);
      const emit = (event: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      const openStream = () => {
        state.opened++;
        return new Response(
          new ReadableStream({
            start(next) {
              controller = next;
              emit({ type: "thread", thread, runId: "92000000-0000-4000-8000-000000000002" });
              emit({ type: "text", text: "Working " });
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      };
      Object.assign(window, {
        liveRefreshTest: {
          state,
          log,
          finish() {
            emit({ type: "done" });
            controller.close();
          },
        },
      });
      window.fetch = async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          location.href,
        );
        if (url.pathname === `/api/chat/threads/${thread.id}`) return Response.json(thread);
        // The session query is cached idle: no run claim to fall back on.
        if (url.pathname === `/api/chat/threads/${thread.id}/session`)
          return Response.json({ changed: false, running: false, live: null, queued: [] });
        if (url.pathname === `/api/chat/threads/${thread.id}/live`) {
          state.attaches++;
          note("attach");
          // Hold the reattach open so the pending-reattach window is observable.
          await new Promise((resolve) => setTimeout(resolve, 2000));
          note("attach-open");
          return openStream();
        }
        if (url.pathname === "/api/chat/stream") {
          state.posts++;
          note("post-stream");
          return openStream();
        }
        if (url.pathname.endsWith("/cancel")) return Response.json({ ok: true });
        return original(input, init);
      };
    },
    { thread, secret: API_SECRET },
  );
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await page.route(/\/api\/projects(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { projects: [] } }),
  );
  for (const kind of ["live", "archive"] as const)
    await page.route(`**/api/sessions/${kind}?**`, (route) =>
      route.fulfill({ json: { sessions: [], has_more: false } }),
    );

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?chat=open");
  await page.getByTestId("chat-input").fill("Long run");
  await page.getByTestId("chat-send-button").click();
  const panel = page.getByTestId("chat-panel");
  await expect(panel).toHaveAttribute("data-streaming", "true");
  await expect(page.getByTestId("chat-message-content").last()).toContainText("Working");

  // Refresh mid-turn. The snapshot resolves immediately, but the reattach is held
  // open for 2s, so the pending-reattach window is wide enough to assert inside.
  await openChatActions(page);
  await page.getByTestId("chat-refresh-button").filter({ visible: true }).click();
  await expect.poll(() => page.evaluate(() => window.liveRefreshTest.state.attaches)).toBe(1);
  await page.waitForTimeout(600);
  // One-shot reads: a retrying assertion would wait out the delayed attach and
  // mask the very flicker this test exists to catch.
  expect(await panel.getAttribute("data-streaming")).toBe("true");
  expect(await page.getByTestId("chat-working-spinner").count()).toBe(1);
  expect(await page.getByTestId("chat-cancel-button").isVisible()).toBe(true);
  // No transition back to idle may have happened since the turn started, even
  // one too brief for the reads above.
  const flickered = await page.evaluate(() => {
    const entries = window.liveRefreshTest.log;
    const start = entries.findIndex((entry) => entry.kind === "panel" && entry.value === "true");
    return entries
      .slice(start + 1)
      .some((entry) => entry.kind === "panel" && entry.value === "false");
  });
  expect(flickered).toBe(false);

  // Let the delayed reattach open its stream, then finish the turn normally.
  await expect.poll(() => page.evaluate(() => window.liveRefreshTest.state.opened)).toBe(2);
  await expect(panel).toHaveAttribute("data-streaming", "true");
  await page.evaluate(() => window.liveRefreshTest.finish());
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  expect(await page.evaluate(() => window.liveRefreshTest.state.posts)).toBe(1);
});
