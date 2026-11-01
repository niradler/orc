import { ChatSettingsSchema, type ChatThread } from "@orc/core/chat";
import { expect, type Page, type Request, test } from "@playwright/test";
import { API_SECRET } from "./_helpers";

const THREAD = "60000000-0000-4000-8000-000000000001";
const stamp = "2026-10-30T10:00:00.000Z";

const task = {
  id: "t1",
  project_id: "p1",
  title: "Render ORC components in chat",
  body: "Agents answer with live components.",
  status: "doing",
  priority: "high",
  progress: 40,
  due_at: null,
  tags: null,
  author: "human",
  claimed_by: null,
  claim_expires_at: null,
  skill_name: null,
  required_review: false,
  agent_backend: null,
  max_review_rounds: 0,
  created_at: stamp,
  updated_at: stamp,
};
const job = {
  id: "j1",
  project_id: "p1",
  name: "Nightly sync",
  description: "Syncs sessions.",
  command: "orc sync",
  trigger_type: "cron",
  cron_expr: "0 2 * * *",
  enabled: true,
  timeout_secs: 60,
  max_retries: 0,
  overlap: "skip",
  notify_on: "never",
  run_count: 12,
  last_run_at: stamp,
  next_run_at: stamp,
  created_at: stamp,
  updated_at: stamp,
};
const project = {
  id: "p1",
  name: "orc",
  description: null,
  status: "active",
  scope: null,
  git_remote_url: null,
  tags: null,
  obsidian_path: null,
  max_workers: null,
  created_at: stamp,
  updated_at: stamp,
};

const spec = {
  root: "main",
  elements: {
    main: { type: "Stack", children: ["intro", "task", "job", "list", "table", "done"] },
    intro: { type: "Text", props: { text: "Here is the task and its job.", muted: true } },
    task: { type: "Task", props: { id: "t1" } },
    job: { type: "Job", props: { id: "j1" } },
    list: { type: "TaskList", props: { projectId: "p1", limit: 5 } },
    table: {
      type: "Table",
      props: {
        columns: [
          { key: "name", label: "Name" },
          { key: "state", label: "State" },
        ],
        rows: [{ name: "Render ORC components in chat", state: "doing", href: "/tasks/t1" }],
        linkKey: "href",
      },
    },
    done: {
      type: "Button",
      props: { label: "Mark done", variant: "primary" },
      on: { press: { action: "task.update", params: { id: "t1", status: "done" } } },
    },
  },
};

const content = [
  "Here is the component:",
  "```orc-ui",
  JSON.stringify(spec, null, 2),
  "```",
  "And text after it.",
  "```orc-ui",
  '{"root": "broken"',
  "```",
].join("\n");

async function mockApi(page: Page, requests: Request[]) {
  // Registered first so the chat routes below take precedence.
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*\/api/, "");
    const method = request.method();
    if (method !== "GET") requests.push(request);
    if (path === "/tasks/t1" && method === "GET") return route.fulfill({ json: task });
    if (path === "/tasks/t1" && method === "PATCH")
      return route.fulfill({ json: { ...task, ...request.postDataJSON() } });
    if (path === "/tasks") return route.fulfill({ json: { tasks: [task], total: 3 } });
    if (path === "/jobs/j1") return route.fulfill({ json: job });
    if (path === "/jobs/j1/trigger") return route.fulfill({ json: { run_id: "r1" } });
    if (path === "/projects/p1") return route.fulfill({ json: project });
    return route.fallback();
  });
  const now = Date.now();
  const thread: ChatThread = {
    id: THREAD,
    title: "UI fixture",
    updatedAt: now,
    config: ChatSettingsSchema.parse({ agent: "codex" }),
    cwd: "/fixture",
    host: null,
    runtimeId: null,
    sourceId: null,
    backend: "codex-cli",
    messages: [
      { id: "q", role: "user", content: "show me", timestamp: now - 1 },
      { id: "a", role: "assistant", content, timestamp: now },
    ],
  };
  await page.addInitScript(
    ({ secret, id }) => {
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
      localStorage.setItem("orc_chat_tabs", JSON.stringify({ threads: [id], active: id }));
    },
    { secret: API_SECRET, id: THREAD },
  );
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await page.route("**/api/chat/threads", (route) =>
    route.fulfill({
      json: { threads: [{ id: THREAD, title: thread.title, updatedAt: now, running: false }] },
    }),
  );
  await page.route(`**/api/chat/threads/${THREAD}`, (route) => route.fulfill({ json: thread }));
  await page.route(`**/api/chat/threads/${THREAD}/live`, (route) => route.fulfill({ status: 204 }));
}

for (const width of [1440, 390, 320]) {
  test(`orc-ui blocks render live ORC components at ${width}px`, async ({ page }, testInfo) => {
    const requests: Request[] = [];
    await mockApi(page, requests);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/tasks?chat=full&chatThread=${THREAD}`);

    const message = page.getByTestId("chat-message-content").last();
    const block = message.getByTestId("chat-ui-block");
    await expect(block.getByTestId("chat-ui-task")).toContainText(task.title);
    await expect(block.getByTestId("chat-ui-task")).toContainText("orc");
    await expect(block.getByTestId("chat-ui-job")).toContainText("0 2 * * *");
    await expect(block.getByTestId("chat-ui-task-list")).toContainText("1 of 3");
    await expect(block.getByTestId("chat-ui-table").getByRole("link")).toHaveAttribute(
      "href",
      "/tasks/t1",
    );
    await expect(message).toContainText("And text after it.");
    await expect(message.getByTestId("chat-ui-invalid")).toBeVisible();
    const overflow = await block.evaluate((node) => node.scrollWidth - node.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await message.screenshot({ path: testInfo.outputPath(`chat-ui-${width}.png`) });
    expect(errors).toEqual([]);
  });
}

test("orc-ui actions call the API and confirm destructive runs", async ({ page }) => {
  const requests: Request[] = [];
  await mockApi(page, requests);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/tasks?chat=full&chatThread=${THREAD}`);
  const block = page.getByTestId("chat-message-content").last().getByTestId("chat-ui-block");
  await expect(block.getByTestId("chat-ui-task")).toBeVisible();

  await block.getByTestId("chat-ui-task-status").selectOption("review");
  await expect(block.getByTestId("chat-ui-action-result")).toHaveText("Task updated");
  expect(requests.at(-1)?.postDataJSON()).toEqual({ status: "review" });

  await block.getByTestId("chat-ui-button").click();
  await expect.poll(() => requests.at(-1)?.postDataJSON()).toEqual({ status: "done" });

  const triggers = () => requests.filter((request) => request.url().endsWith("/jobs/j1/trigger"));
  await block.getByTestId("chat-ui-job-run").click();
  await page.getByTestId("confirm-dialog-cancel").click();
  expect(triggers()).toHaveLength(0);
  await block.getByTestId("chat-ui-job-run").click();
  await page.getByTestId("confirm-dialog-confirm").click();
  await expect(block.getByTestId("chat-ui-action-result")).toHaveText("Job run started");
  expect(triggers()).toHaveLength(1);
});
