import { ChatSettingsSchema, type ChatThread } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { closeChatHistory, openChatActions, openChatHistory } from "./_chat-ui";
import { API_SECRET } from "./_helpers";

declare global {
  interface Window {
    reconnectTest: {
      state: {
        posts: number;
        attaches: number;
        cancels: number;
        reads: number;
        finished: boolean;
        denied: boolean;
        unavailable: boolean;
      };
      drop(error: boolean): void;
      finish(connected?: boolean): void;
    };
  }
}

test.beforeEach(async ({ page }) => {
  await page.clock.install();
  const thread: ChatThread = {
    id: "10000000-0000-4000-8000-000000000011",
    title: "Reconnect fixture",
    config: ChatSettingsSchema.parse({ agent: "codex" }),
    backend: "codex-cli",
    runtimeId: "reconnect-native",
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
      const state = {
        posts: 0,
        attaches: 0,
        cancels: 0,
        reads: 0,
        finished: false,
        denied: false,
        unavailable: false,
      };
      const emit = (event: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      Object.assign(window, {
        reconnectTest: {
          state,
          drop(error: boolean) {
            if (error) controller.error(new TypeError("Network connection lost"));
            else controller.close();
          },
          finish(connected = true) {
            state.finished = true;
            thread.messages.push({
              id: "reply",
              role: "assistant",
              content: "First Second",
              timestamp: Date.now(),
            });
            if (connected) {
              emit({ type: "text", text: "Second" });
              emit({ type: "done" });
              controller.close();
            }
          },
        },
      });
      window.fetch = async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          location.href,
        );
        if (state.denied && url.pathname === "/api/settings")
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        if (url.pathname.endsWith("/cancel")) state.cancels++;
        if (url.pathname === `/api/chat/threads/${thread.id}`) {
          state.reads++;
          return Response.json(thread);
        }
        if (
          url.pathname === "/api/chat/stream" ||
          url.pathname === `/api/chat/threads/${thread.id}/live`
        ) {
          if (url.pathname.endsWith("/live")) {
            state.attaches++;
            if (state.denied) return Response.json({ error: "Unauthorized" }, { status: 401 });
            if (state.unavailable)
              return Response.json({ error: "Temporarily unavailable" }, { status: 503 });
            if (state.finished) return new Response(null, { status: 204 });
          } else state.posts++;
          return new Response(
            new ReadableStream({
              start(next) {
                controller = next;
                init?.signal?.addEventListener(
                  "abort",
                  () => next.error(new DOMException("Aborted", "AbortError")),
                  { once: true },
                );
                emit({ type: "thread", thread, runId: "10000000-0000-4000-8000-000000000012" });
                emit({ type: "text", text: "First " });
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }
        return original(input, init);
      };
    },
    { thread, secret: API_SECRET },
  );
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await page.goto("/?chat=open");
  await page.getByTestId("chat-input").fill("Long run");
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByTestId("chat-message-content").last()).toContainText("First");
});

for (const error of [false, true]) {
  test(`reattaches after ${error ? "network error" : "premature EOF"} without duplicating the reply or run`, async ({
    page,
  }) => {
    await page.evaluate((error) => window.reconnectTest.drop(error), error);
    await expect.poll(() => page.evaluate(() => window.reconnectTest.state.attaches)).toBe(1);
    await page.evaluate(() => window.reconnectTest.finish());
    await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "false");
    await expect(page.getByTestId("chat-message-content").last()).toHaveText("First Second");
    expect(await page.evaluate(() => window.reconnectTest.state.posts)).toBe(1);
    expect(await page.evaluate(() => window.reconnectTest.state.cancels)).toBe(0);
    await expect(page.getByTestId("chat-message-content")).toHaveCount(2);
  });
}

test("refresh follows the same live turn and reloads a completed conversation at mobile width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const refresh = page.getByTestId("chat-refresh-button");
  await openChatActions(page);
  await refresh.click();
  await expect.poll(() => page.evaluate(() => window.reconnectTest.state.attaches)).toBe(1);
  await page.evaluate(() => window.reconnectTest.finish());
  await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "false");
  await openChatActions(page);
  await refresh.click();
  await expect.poll(() => page.evaluate(() => window.reconnectTest.state.attaches)).toBe(2);
  await expect(page.getByTestId("chat-message-content").last()).toHaveText("First Second");
  await expect(page.getByTestId("chat-message-content")).toHaveCount(2);
  expect(await page.evaluate(() => window.reconnectTest.state.posts)).toBe(1);
  expect(await page.evaluate(() => window.reconnectTest.state.cancels)).toBe(0);
});

test("reloads saved history when the run finishes during a disconnection", async ({ page }) => {
  await page.evaluate(() => {
    window.reconnectTest.drop(false);
    window.reconnectTest.finish(false);
  });
  await expect.poll(() => page.evaluate(() => window.reconnectTest.state.reads)).toBeGreaterThan(0);
  await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "false");
  await expect(page.getByTestId("chat-message-content").last()).toHaveText("First Second");
  await expect(page.getByTestId("chat-message-content")).toHaveCount(2);
});

test("a silent stream reconnects after missed heartbeats", async ({ page }) => {
  await page.clock.fastForward(65_001);
  await page.clock.runFor(1_100);
  await expect.poll(() => page.evaluate(() => window.reconnectTest.state.attaches)).toBe(1);
  await page.evaluate(() => window.reconnectTest.finish());
  await expect(page.getByTestId("chat-message-content").last()).toHaveText("First Second");
});

test("closing a session keeps background reconnect and history without cancelling its agent", async ({
  page,
}) => {
  await page.evaluate(() => window.reconnectTest.drop(false));
  await expect(page.getByTestId("chat-reconnecting")).toBeVisible();
  await openChatHistory(page);
  await page.getByTestId("chat-open-sessions").getByTestId("chat-tab-close").click();
  await closeChatHistory(page);
  await page.clock.fastForward(10_000);
  expect(await page.evaluate(() => window.reconnectTest.state.attaches)).toBe(1);
  await openChatHistory(page);
  await page.getByTestId("chat-earlier-toggle").click();
  await page.getByTestId("chat-closed-sessions").getByTestId("chat-session-select").click();
  await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "true");
  expect(await page.evaluate(() => window.reconnectTest.state.cancels)).toBe(0);
});

test("an unauthorized reattach stops retrying and requests login", async ({ page }) => {
  await page.evaluate(() => {
    window.reconnectTest.state.denied = true;
    window.reconnectTest.drop(false);
  });
  await expect.poll(() => page.evaluate(() => window.reconnectTest.state.attaches)).toBe(1);
  await page.clock.fastForward(10_000);
  expect(await page.evaluate(() => window.reconnectTest.state.attaches)).toBe(1);
  await expect(page.getByTestId("api-login")).toBeVisible();
});

test("bounded retries leave Refresh available for recovery", async ({ page }) => {
  await page.evaluate(() => {
    window.reconnectTest.state.unavailable = true;
    window.reconnectTest.drop(false);
  });
  await page.clock.runFor(6_500);
  await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "false");
  expect(await page.evaluate(() => window.reconnectTest.state.attaches)).toBe(3);
  await page.evaluate(() => {
    window.reconnectTest.state.unavailable = false;
  });
  await openChatActions(page);
  await page.getByTestId("chat-refresh-button").click();
  await expect.poll(() => page.evaluate(() => window.reconnectTest.state.attaches)).toBe(4);
  await page.evaluate(() => window.reconnectTest.finish());
  await expect(page.getByTestId("chat-message-content").last()).toHaveText("First Second");
  await expect(page.getByTestId("chat-message-content")).toHaveCount(2);
});
