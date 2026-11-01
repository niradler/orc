import { ChatSettingsSchema, type ChatThread } from "@orc/core/chat";
import { expect, type Page, type Request, test } from "@playwright/test";
import { CHAT_DASHBOARD_HTML } from "../fixtures/chat-dashboard";
import { chatUiGalleryMessage } from "../fixtures/chat-ui-gallery";
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
    main: { type: "Stack", children: ["task", "job", "list", "done"] },
    task: { type: "Task", props: { id: "t1" } },
    job: { type: "Job", props: { id: "j1" } },
    list: { type: "TaskList", props: { projectId: "p1", limit: 5 } },
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

const artifactSpec = {
  root: "artifact",
  elements: { artifact: { type: "Scratchpad", props: { id: "s1" } } },
};

for (const width of [1440, 390, 320]) {
  test(`HTML dashboard is interactive and isolated at ${width}px`, async ({ page }, testInfo) => {
    await mockApi(page, [], `\`\`\`orc-ui\n${JSON.stringify(artifactSpec)}\n\`\`\``);
    await page.route("**/api/scratchpads/s1", (route) =>
      route.fulfill({
        json: {
          id: "s1",
          title: "Dataset dashboard",
          kind: "html",
          content: CHAT_DASHBOARD_HTML,
          tags: [],
          updated_at: stamp,
        },
      }),
    );
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/tasks?chat=full&chatThread=${THREAD}`);
    const panel = page.getByTestId("chat-ui-scratchpad");
    const frame = page.frameLocator('[data-testid="chat-ui-scratchpad-html"]');
    await expect(frame.getByRole("img", { name: "Quarterly revenue chart" })).toBeVisible();
    await frame.getByRole("button", { name: "Show orders" }).click();
    await expect(frame.getByRole("img", { name: "Quarterly orders chart" })).toBeVisible();
    const iframe = page.getByTestId("chat-ui-scratchpad-html");
    await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    const contentFrame = await (await iframe.elementHandle())?.contentFrame();
    if (!contentFrame) throw new Error("Dashboard frame missing");
    const isolation = await contentFrame.evaluate(async () => {
      let parentBlocked = false;
      let storageBlocked = false;
      let networkBlocked = false;
      try {
        void parent.document.body;
      } catch {
        parentBlocked = true;
      }
      try {
        void localStorage.length;
      } catch {
        storageBlocked = true;
      }
      try {
        await fetch("http://127.0.0.1:7701/api/tasks");
      } catch {
        networkBlocked = true;
      }
      return { parentBlocked, storageBlocked, networkBlocked, bridgeAbsent: !("orc" in window) };
    });
    expect(isolation).toEqual({
      parentBlocked: true,
      storageBlocked: true,
      networkBlocked: true,
      bridgeAbsent: true,
    });
    await panel.getByTestId("chat-ui-fullscreen").click();
    const dialog = page.getByTestId("chat-ui-fullscreen-dialog");
    await expect(dialog).toBeVisible();
    await expect(frame.getByRole("heading", { name: "Dataset dashboard" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`dashboard-fullscreen-${width}.png`) });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(frame.getByRole("heading", { name: "Dataset dashboard" })).toBeVisible();
  });
}

test("scratchpad diagram renders as an isolated image and invalid content stays contained", async ({
  page,
}) => {
  await mockApi(page, [], `\`\`\`orc-ui\n${JSON.stringify(artifactSpec)}\n\`\`\``);
  const content = JSON.stringify({
    type: "excalidraw",
    elements: [
      {
        id: "box",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        strokeColor: "#25262a",
        backgroundColor: "#8ab4f8",
        fillStyle: "solid",
      },
    ],
    appState: {},
    files: {},
  });
  await page.route("**/api/scratchpads/s1", (route) =>
    route.fulfill({
      json: {
        id: "s1",
        title: "Dataset pipeline",
        kind: "diagram",
        content,
        tags: [],
        updated_at: stamp,
      },
    }),
  );
  await page.goto(`/tasks?chat=full&chatThread=${THREAD}`);
  const image = page.getByTestId("chat-ui-scratchpad-diagram");
  await expect(image).toBeVisible();
  expect(
    await image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0),
  ).toBe(true);
  await page.route("**/api/scratchpads/s1", (route) =>
    route.fulfill({
      json: {
        id: "s1",
        title: "Broken diagram",
        kind: "diagram",
        content: "invalid",
        tags: [],
        updated_at: stamp,
      },
    }),
  );
  await page.reload();
  await expect(page.getByTestId("chat-ui-scratchpad").getByRole("alert")).toContainText(
    "Diagram preview unavailable",
  );
  await expect(page.getByTestId("chat-input")).toBeVisible();
});

async function mockApi(page: Page, requests: Request[], messageContent = content) {
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
    if (path === "/projects/p1/summary")
      return route.fulfill({
        json: { project, tasks: { total: 1, by_status: { doing: 1 } }, jobs: 1, memories: 1 },
      });
    if (path === "/projects") return route.fulfill({ json: { projects: [project], total: 1 } });
    if (path === "/jobs") return route.fulfill({ json: { jobs: [job], total: 1 } });
    if (path === "/sessions/live")
      return route.fulfill({
        json: {
          sessions: [
            {
              id: "s1",
              name: "Demo agent session",
              agent: "codex",
              status: "idle",
              last_activity_at: stamp,
            },
          ],
          total: 1,
        },
      });
    if (path === "/memories/demo")
      return route.fulfill({
        json: {
          project_id: "p1",
          name: "demo",
          description: "Gallery memory",
          content: "Example saved fact",
          priority: 50,
          updated_at: stamp,
        },
      });
    if (path === "/scratchpads/s1")
      return route.fulfill({
        json: {
          id: "s1",
          title: "Gallery scratchpad",
          kind: "doc",
          content: "Example document content.",
          tags: ["demo"],
          updated_at: stamp,
        },
      });
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
      { id: "a", role: "assistant", content: messageContent, timestamp: now },
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
  test(`all 7 components render in chat at ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mockApi(
      page,
      [],
      chatUiGalleryMessage({ task: "t1", job: "j1", project: "p1", pad: "s1" }),
    );
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/tasks?chat=full&chatThread=${THREAD}`);
    const block = page.getByTestId("chat-ui-block");
    for (const id of ["task", "task-list", "job", "session-list", "scratchpad"]) {
      await expect(block.getByTestId(`chat-ui-${id}`)).toBeAttached();
    }
    await expect(block).toContainText("Demo agent session");
    await expect(block.getByRole("alert")).toHaveCount(0);
    await expect(page.getByTestId("chat-ui-invalid")).toHaveCount(0);
    expect(await block.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(
      0,
    );
    await block.screenshot({ path: testInfo.outputPath(`all-components-${width}.png`) });
    expect(errors).toEqual([]);
  });
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
    await expect(
      block.getByTestId("chat-ui-task").getByRole("link", { name: task.title }),
    ).toHaveAttribute("href", "/tasks/t1");
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
  await expect(page.getByRole("dialog", { name: "Run this job now?" })).toContainText(
    "Target job: j1",
  );
  await page.getByTestId("confirm-dialog-cancel").click();
  expect(triggers()).toHaveLength(0);
  await block.getByTestId("chat-ui-job-run").click();
  await page.getByTestId("confirm-dialog-confirm").click();
  await expect(block.getByTestId("chat-ui-action-result")).toHaveText("Job run started");
  expect(triggers()).toHaveLength(1);
});

test("component examples in hidden context and outer code fences remain inert", async ({
  page,
}) => {
  const example = `\`\`\`orc-ui\n${JSON.stringify(spec)}\n\`\`\``;
  await mockApi(
    page,
    [],
    `<orc-context>\n${example}\n</orc-context>\nVisible text\n\`\`\`\`markdown\n${example}\n\`\`\`\``,
  );
  await page.goto(`/tasks?chat=full&chatThread=${THREAD}`);
  const message = page.getByTestId("chat-message-content").last();
  await expect(message).toContainText("Visible text");
  await expect(message.getByTestId("chat-ui-block")).toHaveCount(0);
  await expect(message.getByTestId("agent-context")).toHaveCount(0);
});

test("state-bound action parameters resolve on press and do not run on load", async ({ page }) => {
  const requests: Request[] = [];
  const stateSpec = {
    root: "button",
    state: { taskId: "t1" },
    elements: {
      button: {
        type: "Button",
        props: { label: "Mark done" },
        on: {
          press: { action: "task.update", params: { id: { $state: "/taskId" }, status: "done" } },
        },
      },
    },
  };
  await mockApi(page, requests, `\`\`\`orc-ui\n${JSON.stringify(stateSpec)}\n\`\`\``);
  await page.goto(`/tasks?chat=full&chatThread=${THREAD}`);
  const button = page.getByTestId("chat-ui-button");
  await expect(button).toBeVisible();
  expect(requests.filter((request) => request.method() === "PATCH")).toHaveLength(0);
  await button.click();
  await expect(page.getByTestId("chat-ui-action-result")).toHaveText("Task updated");
  const mutation = requests.find((request) => request.method() === "PATCH");
  expect(mutation?.url()).toContain("/api/tasks/t1");
  expect(mutation?.postDataJSON()).toEqual({ status: "done" });
});

for (const theme of ["dark", "light"] as const) {
  for (const width of [1440, 390, 320]) {
    test(`long content expands and enters fullscreen at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      const errors: string[] = [];
      const requests: Request[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const longText = Array.from(
        { length: 12 },
        (_, index) =>
          `Paragraph ${index + 1}: current information with enough detail to need a larger reading view.`,
      ).join("\n\n");
      await page.addInitScript((value) => localStorage.setItem("orc_theme", value), theme);
      const richSpec = {
        root: "main",
        elements: {
          main: { type: "Stack", children: ["task", "sessions", "pad"] },
          task: { type: "Task", props: { id: "t1" } },
          sessions: { type: "SessionList", props: { limit: 10 } },
          pad: { type: "Scratchpad", props: { id: "s1" } },
        },
      };
      await mockApi(page, requests, `\`\`\`orc-ui\n${JSON.stringify(richSpec)}\n\`\`\``);
      await page.route("**/api/tasks/t1", (route) =>
        route.request().method() === "GET"
          ? route.fulfill({ json: { ...task, body: longText } })
          : route.fallback(),
      );
      await page.route("**/api/memories/demo**", (route) =>
        route.fulfill({
          json: {
            project_id: "p1",
            name: "demo",
            description: "Current memory",
            content: longText,
            updated_at: stamp,
          },
        }),
      );
      await page.route("**/api/scratchpads/s1", (route) =>
        route.fulfill({
          json: {
            id: "s1",
            title: "Current document",
            kind: "doc",
            content: longText,
            tags: [],
            updated_at: stamp,
          },
        }),
      );
      await page.route("**/api/sessions/live**", (route) =>
        route.fulfill({
          json: {
            sessions: Array.from({ length: 6 }, (_, index) => ({
              id: `s${index}`,
              name: `Session ${index}`,
              summary: longText,
              agent: "codex",
              status: "idle",
              last_activity_at: stamp,
            })),
            total: 6,
          },
        }),
      );
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/tasks?chat=full&chatThread=${THREAD}`);

      const reader = page.getByTestId("chat-ui-scratchpad");
      const text = page.getByTestId("chat-ui-scratchpad-content").locator("p").first();
      await expect(text).toHaveCSS("-webkit-line-clamp", "4");
      await reader.getByTestId("chat-ui-expand").click();
      await expect(reader).toContainText("Paragraph 12");
      await reader.getByTestId("chat-ui-fullscreen").click();
      const dialog = page.getByTestId("chat-ui-fullscreen-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("Paragraph 12");
      await expect
        .poll(async () => Math.round((await dialog.boundingBox())?.width ?? 0))
        .toBe(width);
      await expect
        .poll(async () => Math.round((await dialog.boundingBox())?.height ?? 0))
        .toBe(900);
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      if (width < 640) {
        const scroller = dialog.getByTestId("chat-ui-fullscreen-content");
        expect(
          await scroller.evaluate((element) => element.scrollHeight > element.clientHeight),
        ).toBe(true);
        await scroller.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        expect(
          (await dialog.getByRole("button", { name: "Close", exact: true }).boundingBox())?.height,
        ).toBeGreaterThanOrEqual(44);
      }
      await page.screenshot({
        path: testInfo.outputPath(`component-fullscreen-${width}-${theme}.png`),
      });
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(reader.getByTestId("chat-ui-fullscreen")).toBeFocused();
      await expect(reader.getByTestId("chat-ui-expand")).toHaveAttribute("aria-expanded", "true");

      const sessions = page.getByTestId("chat-ui-session-list");
      await expect(sessions.locator("li")).toHaveCount(3);
      await sessions.getByTestId("chat-ui-expand").click();
      await expect(sessions.locator("li")).toHaveCount(6);
      const pad = page.getByTestId("chat-ui-scratchpad");
      await pad.getByTestId("chat-ui-fullscreen").click();
      await expect(dialog).toContainText("Paragraph 12");
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const taskPanel = page.getByTestId("chat-ui-task");
      await taskPanel.getByTestId("chat-ui-fullscreen").click();
      await dialog.getByTestId("chat-ui-task-status").selectOption("review");
      await expect(dialog.getByTestId("chat-ui-action-result")).toHaveText("Task updated");
      expect(
        requests
          .filter((request) => request.method() === "PATCH")
          .at(-1)
          ?.postDataJSON(),
      ).toEqual({ status: "review" });
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }
}
