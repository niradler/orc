import { ChatSettingsSchema, type ChatThread } from "@orc/core/chat";
import type { AgentCapabilities } from "@orc/core/types";
import { expect, test } from "@playwright/test";
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
for (const width of [390, 1440]) {
  test(`native steering is explicit and keeps the same conversation at ${width}px`, async ({
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
            state.steer = steering;
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
          if (url.pathname === `/api/chat/threads/${thread.id}`) return Response.json(thread);
          if (url.pathname === `/api/chat/threads/${thread.id}/session`)
            return Response.json({ changed: false, running: false, queued: [] });
          return original(input, init);
        };
      },
      { thread, failFirst: width === 390 },
    );
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
    const steer = page.getByTestId("chat-steer-button");
    await expect(steer).toBeVisible();
    await expect(steer).toBeDisabled();
    await input.fill("Focus on tests");
    await expect(steer).toBeEnabled();
    await expect(page.getByTestId("chat-send-button").filter({ visible: true })).toHaveAttribute(
      "aria-label",
      "Queue message",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`steering-${width}.png`) });
    await steer.click();
    if (width === 390) {
      await expect(page.getByRole("alert")).toContainText("fixture response lost");
      await expect(input).toHaveValue("Focus on tests");
      await steer.click();
    }
    await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "false");
    await expect(input).toHaveValue("");
    await expect(steer).toHaveCount(0);
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
