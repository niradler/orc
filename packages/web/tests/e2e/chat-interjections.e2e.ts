import { ChatSettingsSchema, type ChatThread } from "@orc/core/chat";
import type { AgentCapabilities } from "@orc/core/types";
import { expect, type Page, test } from "@playwright/test";
import { API_SECRET, gotoView } from "./_helpers";

const capabilities: AgentCapabilities = {
  version: 1,
  source: "adapter",
  resume: true,
  modelSelection: true,
  images: true,
  toolOutput: true,
  approvals: true,
  questions: true,
  livePermissions: true,
  interrupt: true,
  steering: true,
  mcp: true,
  fork: false,
  rollback: false,
};

/** The rendered transcript, top to bottom: role plus visible text of each message. */
async function transcript(page: Page): Promise<{ role: string; text: string }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="chat-message"]')].map((element) => ({
      role: element.getAttribute("data-role") ?? "",
      text: (element.querySelector('[data-testid="chat-message-content"]')?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    })),
  );
}

/**
 * A turn that streams prose, takes one human interjection (steer or question
 * answer) mid-turn, then keeps streaming. Mirrors the server contract: the
 * interjection is recorded as a user message, the prose streamed before it is
 * sealed as its own assistant segment, and an `interjection` event tells
 * attached clients to split their live stream at the same point.
 */
async function installInterjectionFixture(
  page: Page,
  thread: ChatThread,
  kind: "steer" | "question",
) {
  await page.addInitScript(
    ({ thread, kind }) => {
      const original = window.fetch.bind(window);
      const encoder = new TextEncoder();
      let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
      const emit = (event: unknown) =>
        stream?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      // The reload reads the stored transcript back through GET, like the real store.
      const stored = localStorage.getItem("interjection-fixture-thread");
      if (stored) Object.assign(thread, JSON.parse(stored));
      const persist = () =>
        localStorage.setItem("interjection-fixture-thread", JSON.stringify(thread));
      const runId = "30000000-0000-4000-8000-000000000002";
      const record = (message: {
        id: string;
        role: "user";
        content: string;
        timestamp: number;
      }) => {
        // The server freezes the prose streamed so far before the human message.
        thread.messages.push({
          id: "segment-1",
          role: "assistant",
          content: "Part one.",
          timestamp: Date.now(),
        });
        thread.messages.push(message);
        persist();
        emit({ type: "interjection", message });
        emit({
          type: "thread",
          thread: { ...thread, messages: thread.messages.slice(-1) },
          runId,
        });
      };
      const finishTurn = (reply: string) => {
        emit({ type: "text", text: reply });
        emit({ type: "session", runtimeId: thread.runtimeId });
        emit({ type: "done" });
        stream?.close();
        thread.messages.push({
          id: "reply",
          role: "assistant",
          content: reply,
          timestamp: Date.now(),
          turn: { startedAt: Date.now() - 1000, finishedAt: Date.now(), outcome: "completed" },
        });
        persist();
      };
      window.fetch = async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          location.href,
        );
        if (url.pathname === "/api/chat/stream") {
          const sent = JSON.parse(String(init?.body));
          thread.messages = [
            {
              id: "first",
              role: "user",
              content: sent.messages.at(-1).content,
              timestamp: Date.now(),
            },
          ];
          persist();
          return new Response(
            new ReadableStream({
              start(controller) {
                stream = controller;
                emit({ type: "thread", thread, runId });
                emit({ type: "capabilities", capabilities: thread.capabilities });
                emit({ type: "text", text: "Part one." });
                if (kind === "question") {
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
                }
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }
        if (url.pathname.endsWith("/steer")) {
          const steering: { input: string; requestId: string } = JSON.parse(String(init?.body));
          record({
            id: steering.requestId,
            role: "user",
            content: steering.input,
            timestamp: Date.now(),
          });
          setTimeout(() => finishTurn(" Part two."), 300);
          return Response.json(thread);
        }
        if (url.pathname.endsWith("/answer")) {
          const message = {
            id: "answer-message",
            role: "user" as const,
            content: "Choose a color: Blue",
            timestamp: Date.now(),
          };
          record(message);
          emit({ type: "request_resolved", requestId: "question-1" });
          setTimeout(() => finishTurn("Blue accepted."), 300);
          return Response.json({ ok: true, message });
        }
        if (url.pathname === `/api/chat/threads/${thread.id}`) return Response.json(thread);
        if (url.pathname === `/api/chat/threads/${thread.id}/live`)
          return new Response(null, { status: 204 });
        if (url.pathname === `/api/chat/threads/${thread.id}/session`)
          return Response.json({ changed: false, running: false, queued: [] });
        return original(input, init);
      };
    },
    { thread, kind },
  );
}

function fixtureThread(id: string, title: string): ChatThread {
  return {
    id,
    title,
    config: ChatSettingsSchema.parse({ agent: "codex", model: "" }),
    backend: "codex-cli",
    capabilities,
    runtimeId: "native-interjection",
    sourceId: null,
    cwd: "/fixture",
    host: null,
    messages: [],
    updatedAt: Date.now(),
  };
}

for (const width of [390, 1440]) {
  test(`a steered message keeps its place in the stream at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    await request.patch("/api/settings", {
      headers: { Authorization: `Bearer ${API_SECRET}` },
      data: { chat: ChatSettingsSchema.parse({ agent: "codex", model: "" }) },
    });
    const thread = fixtureThread("30000000-0000-4000-8000-000000000001", "Steer order");
    await installInterjectionFixture(page, thread, "steer");
    await page.route("**/api/chat/models?**", (route) =>
      route.fulfill({ json: { models: [], warning: null } }),
    );
    await page.setViewportSize({ width, height: 900 });
    await gotoView(page, "tasks");
    await page.goto("/tasks?chat=open");
    const input = page.getByTestId("chat-input").filter({ visible: true });
    await input.fill("Implement the change");
    await page.getByTestId("chat-send-button").filter({ visible: true }).click();
    await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "true");
    await expect(
      page.getByTestId("chat-message-content").filter({ hasText: "Part one." }),
    ).toBeVisible();
    await input.fill("Focus on tests");
    await page.getByTestId("chat-send-button").filter({ visible: true }).click();
    // While the turn keeps streaming, the steer sits after the prose it followed.
    await expect
      .poll(async () => (await transcript(page)).map((entry) => entry.text).join(" | "))
      .toContain("Part one. | Focus on tests");
    await page.screenshot({ path: testInfo.outputPath(`steer-order-live-${width}.png`) });
    await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "false");
    const finished = await transcript(page);
    expect(finished.map((entry) => `${entry.role}: ${entry.text}`)).toEqual([
      "user: Implement the change",
      "assistant: Part one.",
      "user: Focus on tests",
      "assistant: Part two.",
    ]);
    await page.screenshot({ path: testInfo.outputPath(`steer-order-finished-${width}.png`) });
    // A reload reads the stored transcript: the same order survives.
    await page.reload();
    await expect
      .poll(async () => (await transcript(page)).map((entry) => entry.text).join(" | "))
      .toBe("Implement the change | Part one. | Focus on tests | Part two.");
  });

  test(`a question answer stays visible in the chat at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    await request.patch("/api/settings", {
      headers: { Authorization: `Bearer ${API_SECRET}` },
      data: { chat: ChatSettingsSchema.parse({ agent: "codex", model: "" }) },
    });
    const thread = fixtureThread("30000000-0000-4000-8000-000000000003", "Answer visible");
    await installInterjectionFixture(page, thread, "question");
    await page.route("**/api/chat/models?**", (route) =>
      route.fulfill({ json: { models: [], warning: null } }),
    );
    await page.setViewportSize({ width, height: 900 });
    await gotoView(page, "tasks");
    await page.goto("/tasks?chat=open");
    const input = page.getByTestId("chat-input").filter({ visible: true });
    await input.fill("Pick a color");
    await page.getByTestId("chat-send-button").filter({ visible: true }).click();
    await expect(page.getByTestId("chat-question").filter({ visible: true })).toBeVisible();
    await page.getByTestId("chat-question-answer").filter({ visible: true }).first().fill("Blue");
    await page.getByTestId("chat-question-submit").filter({ visible: true }).click();
    await expect(page.getByTestId("chat-question")).toHaveCount(0);
    // The answer is part of the conversation, not a form that vanished.
    await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "false");
    const finished = await transcript(page);
    expect(finished.map((entry) => `${entry.role}: ${entry.text}`)).toEqual([
      "user: Pick a color",
      "assistant: Part one.",
      "user: Choose a color: Blue",
      "assistant: Blue accepted.",
    ]);
    await page.screenshot({ path: testInfo.outputPath(`answer-visible-${width}.png`) });
    await page.reload();
    await expect
      .poll(async () => (await transcript(page)).map((entry) => entry.text).join(" | "))
      .toBe("Pick a color | Part one. | Choose a color: Blue | Blue accepted.");
  });
}
