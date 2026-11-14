import { spawnSync } from "node:child_process";
import { type ChatActivity, ChatSettingsSchema } from "@orc/core/chat";
import { expect, type Page, test } from "@playwright/test";
import { API_SECRET, repoRoot } from "./_helpers";

const headers = { Authorization: `Bearer ${API_SECRET}` };
const defaults = ChatSettingsSchema.parse({});

type StreamWindow = Window & {
  chatStreams: number;
  pushChat: (index: number, events: unknown[]) => void;
};

test.beforeEach(async ({ page, request }) => {
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await request.patch("/api/settings", { headers, data: { chat: defaults } });
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
});

function seed(thread: unknown): void {
  const seeded = spawnSync(
    "bun",
    [
      "-e",
      'import {getSqlite} from "./packages/db/src/client.ts";import {ChatStore} from "./packages/db/src/chat.ts";new ChatStore(getSqlite()).save(JSON.parse(process.argv[1]));',
      JSON.stringify(thread),
    ],
    { cwd: repoRoot(), env: process.env, encoding: "utf8", timeout: 10000 },
  );
  expect(seeded.status, seeded.stderr).toBe(0);
}

function chatThread(id: string, title: string, activity: ChatActivity[], started: number) {
  return {
    id,
    title,
    config: defaults,
    cwd: "/tmp",
    host: null,
    runtimeId: null,
    backend: "codex-cli",
    sourceId: null,
    updatedAt: started + 40_000,
    messages: [
      {
        id: `${id}-user`,
        role: "user",
        content: "Run the suite and check the docs",
        timestamp: started,
      },
      {
        id: `${id}-assistant`,
        role: "assistant",
        content: "The suite is running.",
        timestamp: started + 40_000,
        turn: {
          startedAt: started,
          finishedAt: started + 40_000,
          durationMs: 40_000,
          outcome: "completed",
        },
        activity,
      },
    ],
  };
}

function detachedCommand(id: string, command: string, startedAt: number): ChatActivity {
  return {
    type: "tool",
    id,
    name: "Bash",
    input: JSON.stringify({ command, run_in_background: true }),
    result: "Command running in background with ID: bash_1",
    startedAt,
    background: "command",
  };
}

/** A child session the parent started, still queued for a worker. */
function childThread(parentId: string, started: number) {
  return {
    ...chatThread(crypto.randomUUID(), "Reword the release notes", [], started),
    spawnedBy: {
      sessionId: parentId,
      at: started,
      notify: true,
      prompt: "Reword the release notes",
    },
  };
}

for (const width of [1440, 390]) {
  test(`detached work and a started session stay visible at ${width}px`, async ({ page }) => {
    const parentId = crypto.randomUUID();
    const started = Date.now() - 125_000;
    seed(
      chatThread(
        parentId,
        "Background work",
        [detachedCommand("bash-1", "bun test --watch", started)],
        started,
      ),
    );
    const child = childThread(parentId, started + 5_000);
    seed(child);

    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/tasks?chat=open&chatThread=${parentId}`);
    const strip = page.getByTestId("chat-background-work");
    await expect(strip).toBeVisible();
    await expect(strip.getByTestId("chat-background-title")).toHaveText(
      "Running 1 command and 1 subagent",
    );
    await page.screenshot({ path: test.info().outputPath(`background-${width}.png`) });

    await page.getByTestId("chat-background-summary").click();
    const command = strip.locator('[data-testid="chat-background-item"][data-kind="command"]');
    await expect(command).toContainText("bun test --watch");
    await expect(command.getByRole("timer")).toHaveText(/^2:0\d$/);
    const session = strip.locator('[data-testid="chat-background-item"][data-kind="subagent"]');
    await expect(session).toContainText("Reword the release notes");
    await expect(session).toContainText("Queued");
    await expect(session.getByTestId("chat-background-open")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`background-open-${width}.png`) });

    await session.getByTestId("chat-background-stop").click();
    // One job left: the block falls back to its single-line form.
    await expect(strip).toContainText("bun test --watch");
    await expect(strip.getByTestId("chat-background-item")).toHaveCount(0);
    await expect(strip).not.toContainText("Reword the release notes");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test("opening a background session shows its conversation", async ({ page }) => {
  const parentId = crypto.randomUUID();
  const started = Date.now() - 60_000;
  seed(chatThread(parentId, "Parent chat", [], started));
  const child = childThread(parentId, started + 5_000);
  seed(child);

  await page.goto(`/?chat=open&chatThread=${parentId}`);
  await page.getByTestId("chat-background-open").click();
  await expect(page.getByRole("heading", { name: "Reword the release notes" })).toBeVisible();
  await expect(page.getByTestId("chat-background-work")).toBeHidden();
});

test("a turn that detaches a command shows it while it runs", async ({ page }) => {
  await installStreamControl(page);
  await page.goto("/?chat=open");
  await page.getByTestId("chat-input").fill("Run the suite in the background");
  await page.getByTestId("chat-send-button").click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as StreamWindow).chatStreams))
    .toBe(1);
  await push(page, 0, [
    { type: "thread", thread: fakeThread(), runId: crypto.randomUUID() },
    {
      type: "tool_use",
      data: {
        id: "bash-live",
        name: "Bash",
        input: JSON.stringify({ command: "bun run scripts/run-e2e.ts", run_in_background: true }),
      },
    },
  ]);
  const live = page.getByTestId("chat-activity-status");
  await expect(live).toContainText("Working for");
  // The trail names the call and keeps its own clock, so a quiet command still reads as alive.
  await expect(page.getByTestId("chat-current-tool")).toContainText("Bash");
  await expect(page.getByTestId("chat-current-tool-elapsed")).toBeVisible();
  const strip = page.getByTestId("chat-background-work");
  await expect(strip).toBeVisible();
  await expect(strip).toContainText("bun run scripts/run-e2e.ts");
  await page.screenshot({ path: test.info().outputPath("background-live.png") });
});

function fakeThread() {
  return {
    id: crypto.randomUUID(),
    title: "Background run",
    config: defaults,
    cwd: "/tmp",
    host: null,
    runtimeId: null,
    backend: "codex-cli",
    sourceId: null,
    updatedAt: Date.now(),
    messages: [],
  };
}

async function installStreamControl(page: Page) {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const encoder = new TextEncoder();
    Object.assign(window, {
      chatStreams: 0,
      pushChat: (index: number, events: unknown[]) => {
        const controller = controllers[index];
        if (!controller) throw new Error(`no stream ${index}`);
        for (const event of events)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      },
    });
    window.fetch = async (input, init) => {
      if (!String(input).endsWith("/chat/stream")) return original(input, init);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controllers.push(controller);
          (window as unknown as { chatStreams: number }).chatStreams = controllers.length;
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
  });
}

async function push(page: Page, index: number, events: unknown[]) {
  await page.evaluate(
    ([index, events]) => (window as unknown as StreamWindow).pushChat(index, events),
    [index, events] as const,
  );
}
