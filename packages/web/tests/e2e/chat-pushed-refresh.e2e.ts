import { ChatSettingsSchema, type ChatThread } from "@orc/core/chat";
import { expect, type Page, type Route, test } from "@playwright/test";
import { openChatHistory, waitHistoryClosed } from "./_chat-ui";
import { API_SECRET } from "./_helpers";

type SessionState = {
  changed: boolean;
  running: boolean;
  queued: { id: string; title: string }[];
  live: { id: string; agent: string; status: string } | null;
};

async function openPushedChat(
  page: Page,
  agent: string,
  state: SessionState,
  next: (thread: ChatThread) => ChatThread,
  width = 1440,
) {
  const now = Date.now();
  let thread: ChatThread = {
    id: "80000000-0000-4000-8000-0000000000a1",
    title: "Session changed outside ORC",
    config: ChatSettingsSchema.parse({ agent, model: "fixture-model" }),
    cwd: "/fixture/agent",
    host: null,
    runtimeId: "native-runtime",
    sourceId: null,
    backend: agent === "codex" ? "codex-cli" : "claude",
    updatedAt: now - 5000,
    messages: [{ id: "m1", role: "user", content: "Check positions", timestamp: now - 6000 }],
  };
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await page.route("**/api/chat/threads", (route) =>
    route.fulfill({
      json: {
        threads: [
          {
            id: thread.id,
            title: thread.title,
            agent,
            running: false,
            updatedAt: thread.updatedAt,
          },
        ],
      },
    }),
  );
  await page.route(`**/api/chat/threads/${thread.id}`, (route) => route.fulfill({ json: thread }));
  await page.route(`**/api/chat/threads/${thread.id}/session`, (route) =>
    route.fulfill({ json: state }),
  );
  let rebuilt = 0;
  await page.route(`**/api/chat/threads/${thread.id}/refresh`, (route) => {
    rebuilt++;
    thread = next(thread);
    state.changed = false;
    state.queued = [];
    return route.fulfill({ json: thread });
  });
  await page.route("**/api/chat/threads/*/live", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
  await page.route("**/api/sessions/archive?**", (route) =>
    route.fulfill({ json: { sessions: [], has_more: false } }),
  );
  await page.route("**/api/sessions/live?**", (route) =>
    route.fulfill({ json: { sessions: [], has_more: false } }),
  );
  const streams: Route[] = [];
  await page.route("**/api/events", (route) => {
    streams.push(route);
  });
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/tasks?chat=full");
  await openChatHistory(page);
  await page
    .getByTestId("chat-session-list")
    .locator(`[data-history-id="chat:${thread.id}"]`)
    .getByTestId("chat-resume-thread")
    .click();
  await waitHistoryClosed(page);
  return {
    rebuilt: () => rebuilt,
    async pushSessions() {
      await expect.poll(() => streams.length).toBeGreaterThan(0);
      const route = streams.pop() as Route;
      streams.length = 0;
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: 'event: change\ndata: {"resources":["sessions"]}\n\n',
      });
    },
  };
}

const reply = (content: string) => (thread: ChatThread) => ({
  ...thread,
  updatedAt: Date.now(),
  messages: [
    ...thread.messages,
    { id: `m${thread.messages.length + 1}`, role: "assistant" as const, content, timestamp: 1 },
  ],
});

test("a chat whose session changed on disk rebuilds itself without a manual refresh", async ({
  page,
}) => {
  const chat = await openPushedChat(
    page,
    "codex",
    { changed: true, running: false, queued: [{ id: "hr-1", title: "IBKR check" }], live: null },
    reply("Token expired; renew it."),
  );
  await expect(
    page.getByTestId("chat-messages").getByText("Token expired; renew it."),
  ).toBeVisible();
  await expect(page.getByTestId("chat-live-announcer")).toContainText("Token expired; renew it.");
  expect(chat.rebuilt()).toBe(1);
  const refresh = page.getByTestId("chat-refresh-button").filter({ visible: true });
  await expect(refresh).not.toHaveAttribute("data-stale", "true");
  await expect(refresh).toHaveAccessibleName("Refresh session");
  await expect(page.getByTestId("chat-message-queue")).toHaveCount(0);
});

for (const width of [1440, 390]) {
  test(`a turn running in its own agent streams in over SSE and blocks sending at ${width}px`, async ({
    page,
  }, testInfo) => {
    const state: SessionState = {
      changed: false,
      running: false,
      queued: [],
      live: { id: "live-1", agent: "claude", status: "running" },
    };
    let turn = 0;
    const chat = await openPushedChat(
      page,
      "claude",
      state,
      (thread) => reply(`Agent step ${++turn}`)(thread),
      width,
    );
    const input = page.getByTestId("chat-input");
    const send = page.getByTestId("chat-send-button");
    await expect(input).toHaveAttribute("placeholder", /Running in its own agent/);
    await expect(page.getByTestId("chat-agent-running")).toBeVisible();
    await input.fill("Can I interrupt?");
    await expect(send).toBeDisabled();
    await input.press("Enter");
    await expect(input).toHaveValue("Can I interrupt?");
    await page.screenshot({ path: testInfo.outputPath(`agent-running-${width}.png`) });

    state.changed = true;
    await chat.pushSessions();
    await expect(page.getByTestId("chat-messages").getByText("Agent step 1")).toBeVisible();
    state.changed = true;
    await chat.pushSessions();
    await expect(page.getByTestId("chat-messages").getByText("Agent step 2")).toBeVisible();
    expect(chat.rebuilt()).toBe(2);
    await expect(send).toBeDisabled();

    state.live = { id: "live-1", agent: "claude", status: "idle" };
    await chat.pushSessions();
    await expect(send).toBeEnabled();
    await expect(page.getByTestId("chat-agent-running")).toHaveCount(0);
    await expect(input).toHaveAttribute("placeholder", "Ask anything. / for prompts and skills");
    await expect(input).toHaveValue("Can I interrupt?");
  });
}
