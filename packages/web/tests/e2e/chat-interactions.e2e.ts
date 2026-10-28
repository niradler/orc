import { ChatSettingsSchema, type ChatThread } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { chooseChatAgent, openChatActions, openChatSettings, settingsSection } from "./_chat-ui";
import { API_SECRET, gotoView } from "./_helpers";

for (const width of [390, 1440]) {
  test(`chat answers approvals/questions and exposes quiet continuation icons at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    const config = ChatSettingsSchema.parse({ agent: "codex", permissionMode: "default" });
    await request.patch("/api/settings", {
      headers: { Authorization: `Bearer ${API_SECRET}` },
      data: { chat: config },
    });
    const thread: ChatThread = {
      id: "10000000-0000-4000-8000-000000000001",
      title: "Interactive validation",
      config,
      backend: "codex-cli",
      runtimeId: "native-icons",
      sourceId: "source-icons",
      cwd: "/fixture",
      host: null,
      messages: [],
      updatedAt: Date.now(),
    };
    await page.addInitScript(
      ({ thread }) => {
        const original = window.fetch.bind(window);
        const encoder = new TextEncoder();
        let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
        const emit = (event: unknown) =>
          stream?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        const state = {
          body: {} as Record<string, unknown>,
          permission: {} as Record<string, unknown>,
          answer: {} as Record<string, unknown>,
        };
        Object.assign(window, { chatInteractionTest: state });
        window.fetch = async (input, init) => {
          const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            location.href,
          );
          if (url.pathname === "/api/chat/stream") {
            state.body = JSON.parse(String(init?.body));
            thread.config.permissionMode = state.body
              .permissionMode as typeof thread.config.permissionMode;
            return new Response(
              new ReadableStream({
                start(controller) {
                  stream = controller;
                  emit({
                    type: "thread",
                    thread: { ...thread, runtimeId: null },
                    runId: "10000000-0000-4000-8000-000000000002",
                  });
                  emit({
                    type: "permission_request",
                    data: { requestId: "approval-1", tool: "command", command: "echo harmless" },
                  });
                  emit({
                    type: "question_request",
                    data: {
                      requestId: "question-1",
                      questions: [
                        {
                          id: "color",
                          header: "Color",
                          question: "Choose a color",
                          options: [{ label: "Blue", description: "Use blue" }],
                        },
                      ],
                    },
                  });
                },
              }),
              { headers: { "Content-Type": "text/event-stream" } },
            );
          }
          if (url.pathname.endsWith("/permission")) {
            state.permission = JSON.parse(String(init?.body));
            emit({ type: "request_resolved", requestId: "approval-1" });
            return Response.json({ ok: true });
          }
          if (url.pathname.endsWith("/answer")) {
            state.answer = JSON.parse(String(init?.body));
            emit({ type: "request_resolved", requestId: "question-1" });
            emit({ type: "text", text: "Blue accepted" });
            emit({ type: "session", runtimeId: thread.runtimeId });
            emit({ type: "done" });
            stream?.close();
            thread.messages = [
              { id: "answer", role: "assistant", content: "Blue accepted", timestamp: Date.now() },
            ];
            return Response.json({ ok: true });
          }
          if (url.pathname === `/api/chat/threads/${thread.id}`) return Response.json(thread);
          return original(input, init);
        };
      },
      { thread },
    );
    await page.route("**/api/chat/models?**", (route) =>
      route.fulfill({ json: { models: [], warning: null } }),
    );
    const terminal = {
      id: "icon-terminal",
      kind: "codex",
      name: "Codex",
      cwd: "/fixture",
      host: null,
      status: "exited",
      pid: null,
      exit_code: 0,
      live_session_id: "source-icons",
      created_at: new Date().toISOString(),
    };
    await page.route(/\/api\/terminals(?:\?.*)?$/, (route) =>
      route.fulfill({
        json:
          route.request().method() === "POST"
            ? terminal
            : {
                enabled: true,
                ready: true,
                reason: null,
                host: null,
                launchers: ["codex", "shell"],
                terminals: [terminal],
              },
      }),
    );
    await page.route("**/api/sessions/live?**", (route) =>
      route.fulfill({
        json: {
          sessions: [
            {
              id: "source-icons",
              agent: "codex",
              session_id: "native-icons",
              host: null,
              cwd: "/fixture",
              status: "stopped",
              project_id: null,
              task: null,
            },
          ],
        },
      }),
    );
    await page.route("**/api/chat/threads", (route) => route.fulfill({ json: thread }));
    await page.setViewportSize({ width, height: 900 });
    await gotoView(page, "dashboard");
    await page.goto("/?chat=open");
    await openChatSettings(page);
    await page.getByTestId("chat-permission-mode").selectOption("bypassPermissions");
    await page.keyboard.press("Escape");
    await page.getByTestId("chat-input").filter({ visible: true }).fill("Approval and question");
    await page.getByTestId("chat-send-button").filter({ visible: true }).click();
    await expect(page.getByTestId("chat-permission").filter({ visible: true })).toContainText(
      "echo harmless",
    );
    await expect(page.getByTestId("chat-question").filter({ visible: true })).toBeVisible();
    await page.getByTestId("chat-permission-allow").filter({ visible: true }).click();
    await page.getByTestId("chat-question-answer").filter({ visible: true }).fill("Blue");
    await page.getByTestId("chat-question-submit").filter({ visible: true }).click();
    await expect(page.getByTestId("chat-input").filter({ visible: true })).toBeEnabled();
    const state = await page.evaluate(
      () =>
        (
          window as unknown as {
            chatInteractionTest: { body: unknown; permission: unknown; answer: unknown };
          }
        ).chatInteractionTest,
    );
    expect(state.body).toMatchObject({ permissionMode: "bypassPermissions" });
    expect(state.permission).toEqual({ requestId: "approval-1", decision: "approved" });
    expect(state.answer).toEqual({ requestId: "question-1", answers: { color: ["Blue"] } });
    await openChatActions(page);
    const toTerminal = page.getByTestId("chat-continue-terminal").filter({ visible: true });
    await expect(toTerminal).toHaveAttribute("title", "Continue in terminal");
    await expect(toTerminal).toBeEnabled();
    await expect(toTerminal).toHaveText("");
    await page.screenshot({ path: testInfo.outputPath(`chat-interactions-${width}.png`) });
    await toTerminal.click();
    await expect(page).toHaveURL(/\/terminals\/icon-terminal/);
    const toChat = page.getByTestId("terminal-continue-chat").filter({ visible: true });
    await expect(toChat).toHaveAttribute("title", "Continue in chat");
    await expect(toChat).toHaveText("");
    await toChat.click();
    await expect(page).toHaveURL(/chat=open/);
    await expect(page.getByTestId("chat-input").filter({ visible: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test("permission defaults persist through Settings reload", async ({ page }) => {
  await gotoView(page, "settings");
  await settingsSection(page, "chat");
  const selector = page.getByTestId("chat-permission-mode");
  await selector.selectOption("bypassPermissions");
  await page.getByTestId("chat-settings-save").click();
  await expect(page.getByTestId("chat-settings-feedback")).toContainText("saved");
  await page.reload();
  await expect(selector).toHaveValue("bypassPermissions");
  await selector.selectOption("default");
  await page.getByTestId("chat-settings-save").click();
});

test("switching to an ACPX agent keeps its native permission policy", async ({ page, request }) => {
  await request.patch("/api/settings", {
    headers: { Authorization: `Bearer ${API_SECRET}` },
    data: { chat: ChatSettingsSchema.parse({ permissionMode: "bypassPermissions" }) },
  });
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  let sent: Record<string, unknown> | undefined;
  await page.route("**/api/chat/stream", (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({
      contentType: "text/event-stream",
      body: 'data: {"type":"text","text":"Native policy"}\n\ndata: {"type":"done"}\n\n',
    });
  });
  await gotoView(page, "dashboard");
  await page.goto("/?chat=open");
  await chooseChatAgent(page, "gemini");
  await page.getByTestId("chat-input").filter({ visible: true }).fill("Use native policy");
  await page.getByTestId("chat-send-button").filter({ visible: true }).click();
  await expect(page.getByTestId("chat-input").filter({ visible: true })).toBeEnabled();
  expect(sent).toMatchObject({ agent: "gemini" });
  expect(sent).not.toHaveProperty("permissionMode");
});
