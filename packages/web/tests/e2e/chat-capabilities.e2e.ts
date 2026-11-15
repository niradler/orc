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
async function installSteeringFixture(
  page: Page,
  thread: ChatThread,
  options: { failFirst?: boolean } = {},
) {
  await page.addInitScript(
    ({ thread, failFirst }) => {
      const original = window.fetch.bind(window);
      const encoder = new TextEncoder();
      let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
      const emit = (event: unknown) =>
        stream?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      const state = {
        steer: null as null | { input: string },
        starts: 0,
        requests: [] as string[],
        inputs: [] as string[],
        nativeSteers: 0,
      };
      Object.assign(window, { steeringTest: state });
      window.fetch = async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          location.href,
        );
        if (url.pathname === "/api/chat/stream") {
          state.starts++;
          const sent = JSON.parse(String(init?.body));
          thread.messages = [
            {
              id: "first",
              role: "user",
              content: sent.messages.at(-1).content,
              timestamp: Date.now(),
            },
          ];
          return new Response(
            new ReadableStream({
              start(controller) {
                stream = controller;
                emit({ type: "thread", thread, runId: "20000000-0000-4000-8000-000000000002" });
                emit({ type: "capabilities", capabilities: thread.capabilities });
                emit({ type: "text", text: "Working on the requested change." });
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }
        if (url.pathname.endsWith("/steer")) {
          const steering: { input: string; requestId: string } = JSON.parse(String(init?.body));
          state.requests.push(steering.requestId);
          state.inputs.push(steering.input);
          state.steer = steering;
          const conflict = Reflect.get(window, "steerConflict") as
            | { error: string; code: string }
            | undefined;
          if (conflict) return Response.json(conflict, { status: 409 });
          if (!thread.messages.some((message) => message.id === steering.requestId)) {
            state.nativeSteers++;
            thread.messages.push({
              id: steering.requestId,
              role: "user",
              content: steering.input,
              timestamp: Date.now(),
            });
          }
          if (failFirst && state.requests.length === 1)
            return Response.json(
              { error: "fixture response lost", code: "FIXTURE" },
              { status: 503 },
            );
          setTimeout(() => {
            emit({ type: "text", text: " Updated focus accepted." });
            emit({ type: "session", runtimeId: thread.runtimeId });
            emit({ type: "done" });
            stream?.close();
            thread.messages.push({
              id: "reply",
              role: "assistant",
              content: "Updated focus accepted.",
              timestamp: Date.now(),
            });
          }, 100);
          return Response.json(thread);
        }
        if (url.pathname === `/api/chat/threads/${thread.id}/config`) {
          const patch = JSON.parse(String(init?.body));
          thread.config = { ...thread.config, ...patch };
          return Response.json(thread);
        }
        if (url.pathname === `/api/chat/threads/${thread.id}`) return Response.json(thread);
        if (url.pathname === `/api/chat/threads/${thread.id}/session`)
          return Response.json({ changed: false, running: false, queued: [] });
        return original(input, init);
      };
    },
    { thread, failFirst: options.failFirst ?? false },
  );
}

for (const width of [390, 1440]) {
  test(`steering is the default send and keeps the same conversation at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    const config = ChatSettingsSchema.parse({ agent: "codex", model: "" });
    await request.patch("/api/settings", {
      headers: { Authorization: `Bearer ${API_SECRET}` },
      data: { chat: config },
    });
    const thread: ChatThread = {
      id: "20000000-0000-4000-8000-000000000001",
      title: "Codex steering",
      config,
      backend: "codex-cli",
      capabilities,
      runtimeId: "native-steer",
      sourceId: null,
      cwd: "/fixture",
      host: null,
      messages: [],
      updatedAt: Date.now(),
    };
    await installSteeringFixture(page, thread, { failFirst: width === 390 });
    await page.route("**/api/chat/models?**", (route) =>
      route.fulfill({ json: { models: [], warning: null } }),
    );
    await page.addInitScript(
      (theme) => localStorage.setItem("orc_theme", theme),
      width === 390 ? "light" : "dark",
    );
    await page.setViewportSize({ width, height: 900 });
    await gotoView(page, "tasks");
    await page.goto("/tasks?chat=open");
    const input = page.getByTestId("chat-input").filter({ visible: true });
    await input.fill("Implement the change");
    await page.getByTestId("chat-send-button").filter({ visible: true }).click();
    await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "true");
    const queue = page.getByTestId("chat-queue-button");
    await expect(queue).toBeVisible();
    await expect(queue).toBeDisabled();
    await expect(page.getByTestId("chat-steer-button")).toHaveCount(0);
    await input.fill("Focus on tests");
    await expect(queue).toBeEnabled();
    await expect(page.getByTestId("chat-send-button").filter({ visible: true })).toHaveAttribute(
      "aria-label",
      "Send now",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`steering-${width}.png`) });
    const send = page.getByTestId("chat-send-button").filter({ visible: true });
    await send.click();
    if (width === 390) {
      await expect(page.getByRole("alert")).toContainText("fixture response lost");
      await expect(input).toHaveValue("Focus on tests");
      await send.click();
    }
    await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "false");
    await expect(input).toHaveValue("");
    await expect(queue).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, "steeringTest"))).toMatchObject({
      starts: 1,
      nativeSteers: 1,
      steer: { input: "Focus on tests" },
    });
    if (width === 390) {
      const ids = await page.evaluate(
        () => (Reflect.get(window, "steeringTest") as { requests: string[] }).requests,
      );
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(1);
    }
    await expect(
      page.locator('[data-testid="chat-message"][data-role="user"]').last(),
    ).toContainText("Focus on tests");
  });
}

test("a refused steer queues the message and an unconfirmed one is never resent", async ({
  page,
  request,
}) => {
  const config = ChatSettingsSchema.parse({ agent: "codex", model: "" });
  await request.patch("/api/settings", {
    headers: { Authorization: `Bearer ${API_SECRET}` },
    data: { chat: config },
  });
  const thread: ChatThread = {
    id: "20000000-0000-4000-8000-000000000003",
    title: "Steer conflicts",
    config,
    backend: "codex-cli",
    capabilities,
    runtimeId: "native-steer",
    sourceId: null,
    cwd: "/fixture",
    host: null,
    messages: [],
    updatedAt: Date.now(),
  };
  await installSteeringFixture(page, thread);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoView(page, "tasks");
  await page.goto("/tasks?chat=open");
  const panel = page.getByTestId("chat-panel");
  const input = page.getByTestId("chat-input").filter({ visible: true });
  const send = page.getByTestId("chat-send-button").filter({ visible: true });
  const conflict = (value: unknown) =>
    page.evaluate((body) => Reflect.set(window, "steerConflict", body), value);

  await input.fill("Implement the change");
  await send.click();
  await expect(panel).toHaveAttribute("data-streaming", "true");

  // A plain conflict delivered nothing, so the message is safe to queue.
  await conflict({
    error: "This response cannot be steered. Queue a message instead.",
    code: "CONFLICT",
  });
  await input.fill("Queue this one.");
  await send.click();
  await expect(panel.getByTestId("chat-pending-count")).toHaveText("1 pending");
  await expect(panel.getByTestId("chat-error")).toHaveCount(0);

  // An unconfirmed steer may already be in the conversation: keep the text, never queue it.
  await conflict({
    error:
      "Steering delivery could not be confirmed. Check the response before sending another message.",
    code: "STEER_UNCONFIRMED",
  });
  await input.fill("Unconfirmed text.");
  await send.click();
  await expect(panel.getByTestId("chat-error")).toContainText("could not be confirmed");
  await expect(input).toHaveValue("Unconfirmed text.");
  await expect(panel.getByTestId("chat-pending-count")).toHaveText("1 pending");

  // Clearing the refusal lets the same draft steer with the same request ID.
  await conflict(undefined);
  await send.click();
  await expect(panel.getByTestId("chat-error")).toHaveCount(0);
  await expect(page.locator('[data-testid="chat-message"][data-role="user"]').last()).toContainText(
    "Unconfirmed text.",
  );
  const state = await page.evaluate(
    () => Reflect.get(window, "steeringTest") as { nativeSteers: number; requests: string[] },
  );
  expect(state.nativeSteers).toBe(1);
  expect(state.inputs).toEqual(["Queue this one.", "Unconfirmed text.", "Unconfirmed text."]);
  // Retrying the same text reuses its request ID, so a recovery can never send twice.
  expect(state.requests[1]).toBe(state.requests[2]);
});
