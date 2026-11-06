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

function longTurnActivity(): ChatActivity[] {
  const activity: ChatActivity[] = [
    { type: "thinking", id: "think", text: "Plan the refactor across the chat panel" },
    {
      type: "tool",
      id: "edit-panel",
      name: "Edit",
      input: JSON.stringify({
        file_path: "packages/web/src/components/ChatPanel.tsx",
        old_string: "const anchor = useRef(null);\nconst stale = true;\n",
        new_string: "const scroll = usePinnedScroll(options);\n",
      }),
      result: "Updated",
    },
    {
      type: "tool",
      id: "edit-activity",
      name: "Edit",
      input: JSON.stringify({
        file_path: "packages/web/src/lib/chat-activity.ts",
        old_string: "export function groupChatActivity() {}\n",
        new_string: "export function foldTurn() {}\nexport function foldLabel() {}\n",
      }),
      result: "Updated",
    },
    {
      type: "tool",
      id: "write-hook",
      name: "Write",
      input: JSON.stringify({
        file_path: "packages/web/src/hooks/usePinnedScroll.ts",
        content: "export function usePinnedScroll() {\n  return null;\n}\n",
      }),
      result: "Created",
    },
  ];
  for (let index = 0; index < 41; index++) {
    const kind = index % 3;
    activity.push(
      kind === 0
        ? {
            type: "tool",
            id: `read-${index}`,
            name: "Read",
            input: JSON.stringify({ file_path: `packages/web/src/module-${index}.ts` }),
            result: `export const value${index} = ${index};`,
          }
        : kind === 1
          ? {
              type: "tool",
              id: `grep-${index}`,
              name: "Grep",
              input: JSON.stringify({ pattern: `usePinned${index}`, path: "packages/web/src" }),
              result: "No matches",
            }
          : {
              type: "tool",
              id: `bash-${index}`,
              name: "Bash",
              input: JSON.stringify({ command: `bun test tests/unit/case-${index}.test.ts` }),
              result: Array.from({ length: 20 }, (_, line) => `line ${line + 1}`).join("\n"),
            },
    );
  }
  activity.push({
    type: "tool",
    id: "bash-failed",
    name: "Bash",
    input: JSON.stringify({ command: "bun x tsc --noEmit" }),
    result: "error TS2550: Property 'findLast' does not exist",
    isError: true,
  });
  return activity;
}

function seedThread(id: string, started: number) {
  const thread = {
    id,
    title: "Long refactor turn",
    config: defaults,
    cwd: "/tmp",
    host: null,
    runtimeId: null,
    backend: "codex-cli",
    sourceId: null,
    updatedAt: started + 42_000,
    messages: [
      { id: "user", role: "user", content: "Refactor the chat scroll", timestamp: started },
      {
        id: "assistant",
        role: "assistant",
        content: "Refactor finished: the panel now follows only while pinned.",
        timestamp: started + 42_000,
        activity: longTurnActivity(),
      },
    ],
  };
  const seed = spawnSync(
    "bun",
    [
      "-e",
      'import {getSqlite} from "./packages/db/src/client.ts";import {ChatStore} from "./packages/db/src/chat.ts";new ChatStore(getSqlite()).save(JSON.parse(process.argv[1]));',
      JSON.stringify(thread),
    ],
    { cwd: repoRoot(), env: process.env, encoding: "utf8", timeout: 10000 },
  );
  expect(seed.status, seed.stderr).toBe(0);
}

for (const width of [1440, 390]) {
  test(`a long finished turn folds to one line and expands to a diff at ${width}px`, async ({
    page,
  }) => {
    const id = crypto.randomUUID();
    seedThread(id, Date.now() - 120_000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/tasks?chat=open&chatThread=${id}`);
    const fold = page.getByTestId("chat-turn-fold");
    await expect(fold).toHaveCount(1);
    await expect(page.getByTestId("chat-turn-fold-label")).toHaveText(
      "Worked for 42s · 45 tools · 3 files changed",
    );
    await expect(fold).toHaveAttribute("data-failed", "true");
    await expect(page.getByTestId("chat-turn-fold-summary")).toContainText("1 failed");
    await expect(page.getByText("Refactor the chat scroll")).toBeVisible();
    await expect(page.getByText("Refactor finished: the panel now follows")).toBeVisible();
    await expect(page.getByTestId("chat-tool").first()).toBeHidden();

    await page.getByTestId("chat-turn-fold-summary").click();
    await expect(fold).toHaveAttribute("open", "");
    await expect(fold.getByTestId("chat-tool")).toHaveCount(45);
    await expect(fold.getByRole("region", { name: "Tool calls" })).toBeVisible();
    const edit = fold.locator('[data-testid="chat-tool"][data-kind="edit"]').first();
    await expect(edit).toContainText("ChatPanel.tsx");
    await expect(edit.getByTestId("chat-diff-stat").first()).toHaveAccessibleName(
      "1 addition, 2 deletions",
    );
    await edit.locator("summary").click();
    const diff = edit.getByTestId("chat-tool-diff");
    await expect(diff).toBeVisible();
    await expect(diff.getByTestId("git-diff-add")).toContainText("usePinnedScroll(options)");
    await expect(diff.getByTestId("git-diff-remove").first()).toContainText("useRef(null)");

    const command = fold.locator('[data-testid="chat-tool"][data-kind="command"]').first();
    await expect(command).toContainText("bun test tests/unit/case-2.test.ts");
    await command.locator("summary").click();
    await expect(command.getByTestId("chat-tool-output")).toContainText("line 20");
    await expect(command.getByTestId("chat-tool-output")).not.toContainText("line 8\n");
    await expect(command.getByRole("button", { name: "Show 8 earlier lines" })).toBeVisible();
    await expect(fold.locator('[data-testid="chat-tool"][data-kind="lookup"]')).toHaveCount(28);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
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
        if (events.some((event) => (event as { type: string }).type === "done")) controller.close();
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

function paragraphs(from: number, count: number) {
  return Array.from({ length: count }, (_, offset) => ({
    type: "text",
    text: `Paragraph ${from + offset}: the agent explains one more step of the change in detail.\n\n`,
  }));
}

async function distanceFromBottom(page: Page) {
  return page
    .getByTestId("chat-messages")
    .evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
}

test("streaming follows only while pinned and Jump to latest returns with a new count", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installStreamControl(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?chat=open");
  await expect(page.getByTestId("chat-input")).toBeEnabled();
  const messages = page.getByTestId("chat-messages");
  const thread = {
    id: crypto.randomUUID(),
    title: "Streaming fixture",
    config: defaults,
    cwd: "/fixture",
    host: null,
    backend: "codex-cli",
    runtimeId: "fixture-native",
    sourceId: null,
    messages: [],
    updatedAt: Date.now(),
  };

  await page.getByTestId("chat-input").fill("Stream a long answer");
  await page.getByTestId("chat-send-button").click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as StreamWindow).chatStreams))
    .toBe(1);
  await push(page, 0, [
    { type: "thread", thread, runId: crypto.randomUUID() },
    {
      type: "tool_use",
      data: { id: "bash-live", name: "Bash", input: '{"command":"bun run scripts/run-e2e.ts"}' },
    },
    ...paragraphs(1, 30),
  ]);
  const status = page.getByTestId("chat-activity-status");
  await expect(status).toContainText("Working for");
  await expect(page.getByTestId("chat-current-tool")).toContainText("Bash");
  await expect(page.getByTestId("chat-current-tool")).toContainText("bun run scripts/run-e2e.ts");
  expect(
    await status
      .locator("svg")
      .first()
      .evaluate((icon) => getComputedStyle(icon).animationName),
  ).toBe("none");
  const timer = page.getByTestId("chat-working-timer");
  const first = await timer.textContent();
  await expect.poll(() => timer.textContent(), { timeout: 4000 }).not.toBe(first);
  await expect(messages).toContainText("Paragraph 30");
  await expect(messages).toHaveAttribute("data-pinned", "true");
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(4);
  await expect(page.getByTestId("chat-live-announcer")).toContainText("Paragraph", {
    timeout: 5000,
  });

  await messages.hover();
  await page.mouse.wheel(0, -600);
  await expect(messages).toHaveAttribute("data-pinned", "false");
  const jump = page.getByTestId("chat-jump-latest");
  await expect(jump).toBeVisible();
  await expect(jump).toHaveAccessibleName("Jump to latest");
  const held = await messages.evaluate((element) => element.scrollTop);
  await push(page, 0, paragraphs(31, 20));
  await expect(messages).toContainText("Paragraph 50");
  expect(
    Math.abs((await messages.evaluate((element) => element.scrollTop)) - held),
  ).toBeLessThanOrEqual(1);
  expect(await distanceFromBottom(page)).toBeGreaterThan(400);

  await page.getByTestId("chat-input").fill("Then summarize it");
  await page.getByTestId("chat-input").press("Enter");
  await expect(page.getByTestId("chat-queued-message")).toHaveCount(1);
  await push(page, 0, [
    { type: "tool_result", data: { toolUseId: "bash-live", content: "ok", isError: false } },
    { type: "done" },
  ]);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as StreamWindow).chatStreams))
    .toBe(2);
  await expect(jump).toHaveText(/^Jump to latest\s*· 2 new$/);
  await expect(jump).toHaveAccessibleName("Jump to latest, 2 new");
  expect(
    Math.abs((await messages.evaluate((element) => element.scrollTop)) - held),
  ).toBeLessThanOrEqual(1);

  await jump.click();
  await expect(jump).toBeHidden();
  await expect(messages).toHaveAttribute("data-pinned", "true");
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(4);
  await push(page, 1, [
    { type: "thread", thread, runId: crypto.randomUUID() },
    ...paragraphs(100, 15),
  ]);
  await expect(messages).toContainText("Paragraph 114");
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(4);
  await push(page, 1, [{ type: "done" }]);
  await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "false");
});
