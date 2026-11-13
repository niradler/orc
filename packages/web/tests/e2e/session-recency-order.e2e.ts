import { join } from "node:path";
import { ChatSettingsSchema, type ChatThread } from "@orc/core/chat";
import { expect, type Page, test } from "@playwright/test";
import { closeChatHistory, openChatHistory } from "./_chat-ui";
import { API_SECRET, repoRoot } from "./_helpers";

const screen = (name: string) => join(repoRoot(), "docs", "public", "screens", name);

const NAMES = ["Alpha newest", "Beta middle", "Gamma oldest"];

/** Reads the visible row order by the session title each row contains. */
async function rowOrder(page: Page, names: string[]): Promise<(string | undefined)[]> {
  const rows = page.getByTestId("chat-session-list").locator(":scope > [data-history-id]");
  return rows.evaluateAll(
    (elements, wanted) =>
      elements.map((el) => wanted.find((name) => el.textContent?.includes(name))),
    names,
  );
}

/** The list freezes its order while hovered/focused; move away so it reflects live recency. */
async function relaxList(page: Page): Promise<void> {
  const size = page.viewportSize() ?? { width: 1440, height: 900 };
  // Sweep to the top header, well outside the session list, so pointerleave fires.
  await page.mouse.move(Math.round(size.width / 2), 6, { steps: 12 });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Shared route stubs: dev secret, no saved chats, and the live/archive/project payloads. */
async function stubSessionRoutes(
  page: Page,
  sessions: unknown[],
  projects: { id: string; name: string; scope?: string | null; status?: string }[],
): Promise<void> {
  await page.addInitScript((secret) => {
    localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
  }, API_SECRET);
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await page.route("**/api/chat/threads", (route) => route.fulfill({ json: { threads: [] } }));
  await page.route("**/api/sessions/live?**", (route) =>
    route.fulfill({ json: { sessions, has_more: false } }),
  );
  await page.route("**/api/sessions/archive?**", (route) =>
    route.fulfill({ json: { sessions: [], has_more: false } }),
  );
  await page.route(/\/api\/projects(\?.*)?$/, (route) =>
    route.fulfill({ json: { projects, total: projects.length } }),
  );
}

const liveFixture = (
  now: number,
  index: number,
  name: string,
  projectId: string | null,
  agoMinutes: number,
) => ({
  id: `live-${index}`,
  session_id: `runtime-${index}`,
  name,
  agent: "codex",
  status: "stopped",
  cwd: "/fixture/group",
  host: null,
  project_id: projectId,
  task_id: null,
  task: null,
  created_at: new Date(now - 60 * 60_000).toISOString(),
  last_activity_at: new Date(now - agoMinutes * 60_000).toISOString(),
});

for (const width of [1440, 390]) {
  test(`opening a session keeps its recency place; sending a message moves it up at ${width}px`, async ({
    page,
  }) => {
    const now = Date.now();
    const minute = 60_000;
    const ago = [1, 5, 10];
    const sessions = NAMES.map((name, index) => ({
      id: `live-${index}`,
      session_id: `runtime-${index}`,
      name,
      agent: "codex",
      status: "stopped",
      cwd: "/fixture/recency",
      host: null,
      project_id: null,
      task_id: null,
      task: null,
      created_at: new Date(now - 60 * minute).toISOString(),
      last_activity_at: new Date(now - ago[index] * minute).toISOString(),
    }));
    const gamma = sessions[2];
    const resumedId = "60000000-0000-4000-8000-000000000001";
    // The fixed contract: resume carries the conversation's last activity, not the open time.
    const resumed: ChatThread = {
      id: resumedId,
      title: gamma.name,
      config: ChatSettingsSchema.parse({ agent: "codex" }),
      cwd: gamma.cwd,
      host: null,
      runtimeId: gamma.session_id,
      sourceId: gamma.id,
      backend: "codex-cli",
      updatedAt: now - 10 * minute,
      messages: [
        { id: "gamma-q", role: "user", content: "Old question", timestamp: now - 10 * minute },
        { id: "gamma-a", role: "assistant", content: "Old answer", timestamp: now - 10 * minute },
      ],
    };
    await page.addInitScript(
      ({ secret, thread }) => {
        localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
        const original = window.fetch.bind(window);
        const encoder = new TextEncoder();
        window.fetch = async (input, init) => {
          const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            location.href,
          );
          if (url.pathname !== "/api/chat/stream") return original(input, init);
          return new Response(
            new ReadableStream({
              start(controller) {
                const emit = (event: unknown) =>
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                emit({ type: "thread", thread: { ...thread, updatedAt: Date.now() }, runId: "r" });
                emit({ type: "text", data: "Moved up." });
                emit({ type: "done" });
                controller.close();
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        };
      },
      { secret: API_SECRET, thread: resumed },
    );
    await page.route("**/api/chat/models?**", (route) =>
      route.fulfill({ json: { models: [], warning: null } }),
    );
    await page.route("**/api/chat/threads", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: { threads: [] } })
        : route.fulfill({ json: resumed }),
    );
    // A finished turn re-reads the stored thread, so the fixture has to persist the
    // sent turn; otherwise the read reverts the new message and the bumped recency.
    let sent = false;
    const persisted = (): ChatThread => ({
      ...resumed,
      updatedAt: sent ? Date.now() : resumed.updatedAt,
      messages: sent
        ? [
            ...resumed.messages,
            {
              id: "gamma-sent-q",
              role: "user",
              content: "Move this session up",
              timestamp: Date.now(),
            },
            {
              id: "gamma-sent-a",
              role: "assistant",
              content: "Moved up.",
              timestamp: Date.now(),
            },
          ]
        : resumed.messages,
    });
    await page.route(`**/api/chat/threads/${resumedId}`, (route) =>
      route.fulfill({ json: persisted() }),
    );
    await page.route(`**/api/chat/threads/${resumedId}/live`, (route) =>
      route.fulfill({ status: 204 }),
    );
    await page.route("**/api/sessions/live?**", (route) =>
      route.fulfill({ json: { sessions, has_more: false } }),
    );
    await page.route("**/api/sessions/archive?**", (route) =>
      route.fulfill({ json: { sessions: [], has_more: false } }),
    );
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/tasks?chat=full");
    await openChatHistory(page);
    await relaxList(page);
    await expect
      .poll(() => rowOrder(page, NAMES))
      .toEqual(["Alpha newest", "Beta middle", "Gamma oldest"]);

    // Open the oldest session: it must keep its place, not jump to the top.
    await page
      .getByTestId("chat-session-list")
      .locator('[data-history-id="native:live-2"]')
      .getByTestId("chat-resume-live")
      .click();
    await expect(page.getByTestId("chat-message-content").last()).toContainText("Old answer");
    await relaxList(page);
    await openChatHistory(page);
    await relaxList(page);
    await expect
      .poll(() => rowOrder(page, NAMES))
      .toEqual(["Alpha newest", "Beta middle", "Gamma oldest"]);

    // Sending a message is what moves the conversation to the top.
    await closeChatHistory(page);
    await page.getByTestId("chat-input").click();
    await page.getByTestId("chat-input").fill("Move this session up");
    sent = true;
    await expect(page.getByTestId("chat-send-button")).toBeEnabled();
    await page.getByTestId("chat-send-button").click();
    await relaxList(page);
    await openChatHistory(page);
    await relaxList(page);
    await expect
      .poll(() => rowOrder(page, NAMES))
      .toEqual(["Gamma oldest", "Alpha newest", "Beta middle"]);
  });
}

test("Projects groups sessions by project and Recents stays a single descending list", async ({
  page,
}) => {
  const now = Date.now();
  const minute = 60_000;
  const titles = ["Shop checkout", "Billing API", "Loose scratch", "Shop cart"];
  const sessions = [
    { name: "Shop checkout", project_id: "proj-shop", ago: 1 },
    { name: "Shop cart", project_id: "proj-shop", ago: 4 },
    { name: "Billing API", project_id: "proj-billing", ago: 2 },
    { name: "Loose scratch", project_id: null, ago: 3 },
  ].map((session, index) => ({
    id: `live-${index}`,
    session_id: `runtime-${index}`,
    name: session.name,
    agent: "codex",
    status: "stopped",
    cwd: "/fixture/group",
    host: null,
    project_id: session.project_id,
    task_id: null,
    task: null,
    created_at: new Date(now - 60 * minute).toISOString(),
    last_activity_at: new Date(now - session.ago * minute).toISOString(),
  }));
  await page.addInitScript((secret) => {
    localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
  }, API_SECRET);
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await page.route("**/api/chat/threads", (route) => route.fulfill({ json: { threads: [] } }));
  await page.route("**/api/sessions/live?**", (route) =>
    route.fulfill({ json: { sessions, has_more: false } }),
  );
  await page.route("**/api/sessions/archive?**", (route) =>
    route.fulfill({ json: { sessions: [], has_more: false } }),
  );
  await page.route(/\/api\/projects(\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        projects: [
          { id: "proj-shop", name: "Shop", scope: "/fixture/shop", status: "active" },
          { id: "proj-billing", name: "Billing", scope: "/fixture/billing", status: "active" },
        ],
        total: 2,
      },
    }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tasks?chat=full");
  await openChatHistory(page);
  await relaxList(page);

  // Recents is one descending list across projects.
  await expect
    .poll(() => rowOrder(page, titles))
    .toEqual(["Shop checkout", "Billing API", "Loose scratch", "Shop cart"]);

  // Projects groups by project; expanding reveals only that project's sessions.
  await page.getByTestId("session-navigation-projects").click();
  const projectList = page.getByTestId("session-project-list");
  await expect(projectList.getByTestId("session-project-proj-shop")).toContainText("Shop");
  await expect(projectList.getByTestId("session-project-proj-shop")).toContainText("2");
  await expect(projectList.getByTestId("session-project-proj-billing")).toContainText("1");
  await expect(projectList.getByTestId("session-project-unassigned")).toContainText("1");
  await projectList
    .getByTestId("session-project-proj-shop")
    .getByTestId("session-project-toggle")
    .click();
  const shop = projectList.getByTestId("session-project-proj-shop");
  await expect(shop.locator("[data-history-id]")).toHaveCount(2);
  await expect(shop).toContainText("Shop checkout");
  await expect(shop).toContainText("Shop cart");
  await expect(shop).not.toContainText("Billing API");
});

for (const width of [1440, 390]) {
  test(`capture session view screenshots at ${width}px`, async ({ page }, testInfo) => {
    const now = Date.now();
    const minute = 60_000;
    const demo = [
      {
        name: "Redesign the checkout flow",
        project_id: "proj-shop",
        ago: 2,
        status: "running",
        waiting: false,
      },
      {
        name: "Round cart totals to cents",
        project_id: "proj-shop",
        ago: 18,
        status: "stopped",
        waiting: false,
      },
      {
        name: "Fix the payments webhook",
        project_id: "proj-shop",
        ago: 55,
        status: "running",
        waiting: true,
      },
      {
        name: "Upgrade the billing SDK",
        project_id: "proj-billing",
        ago: 8,
        status: "running",
        waiting: false,
      },
      {
        name: "Reconcile invoice exports",
        project_id: "proj-billing",
        ago: 90,
        status: "stopped",
        waiting: false,
      },
      {
        name: "Scratch: explore rate limits",
        project_id: null,
        ago: 35,
        status: "stopped",
        waiting: false,
      },
    ].map((session, index) => ({
      id: `live-${index}`,
      session_id: `runtime-${index}`,
      name: session.name,
      agent: index % 2 ? "codex" : "claude",
      status: session.status,
      waiting_for_human: session.waiting,
      cwd: "/fixture/demo",
      host: null,
      project_id: session.project_id,
      task_id: null,
      task: null,
      created_at: new Date(now - 240 * minute).toISOString(),
      last_activity_at: new Date(now - session.ago * minute).toISOString(),
    }));
    await page.addInitScript((secret) => {
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
      localStorage.setItem("orc_chat_history_section", "recents");
    }, API_SECRET);
    await page.route("**/api/chat/models?**", (route) =>
      route.fulfill({ json: { models: [], warning: null } }),
    );
    await page.route("**/api/chat/threads", (route) => route.fulfill({ json: { threads: [] } }));
    await page.route("**/api/sessions/live?**", (route) =>
      route.fulfill({ json: { sessions: demo, has_more: false } }),
    );
    await page.route("**/api/sessions/archive?**", (route) =>
      route.fulfill({ json: { sessions: [], has_more: false } }),
    );
    await page.route(/\/api\/projects(\?.*)?$/, (route) =>
      route.fulfill({
        json: {
          projects: [
            { id: "proj-shop", name: "Acme Shop", scope: "/fixture/shop", status: "active" },
            {
              id: "proj-billing",
              name: "Billing API",
              scope: "/fixture/billing",
              status: "active",
            },
          ],
          total: 2,
        },
      }),
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/tasks?chat=full");
    await openChatHistory(page);
    await expect(page.getByTestId("chat-session-list").locator("[data-history-id]")).toHaveCount(6);
    const suffix = width === 1440 ? "desktop" : "phone";
    const capture = process.env.ORC_CAPTURE_SESSION_SCREENS === "1";
    const shot = (name: string) => (capture ? screen(name) : testInfo.outputPath(name));
    await page.screenshot({ path: shot(`session-recents-${suffix}.png`) });
    await page.getByTestId("session-navigation-projects").click();
    const projectList = page.getByTestId("session-project-list");
    await projectList
      .getByTestId("session-project-proj-shop")
      .getByTestId("session-project-toggle")
      .click();
    await expect(
      projectList.getByTestId("session-project-proj-shop").locator("[data-history-id]"),
    ).toHaveCount(3);
    await page.screenshot({ path: shot(`session-projects-${suffix}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test("sessions in archived projects stay reachable in the Projects view", async ({ page }) => {
  const now = Date.now();
  const sessions = [
    liveFixture(now, 0, "Active shop work", "proj-shop", 1),
    liveFixture(now, 1, "Old archived work", "proj-old", 2),
  ];
  await stubSessionRoutes(page, sessions, [
    { id: "proj-shop", name: "Shop", scope: "/fixture/shop", status: "active" },
    { id: "proj-old", name: "Old Project", scope: "/fixture/old", status: "archived" },
  ]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tasks?chat=full");
  await openChatHistory(page);
  await relaxList(page);
  await page.getByTestId("session-navigation-projects").click();
  const projectList = page.getByTestId("session-project-list");
  await expect(projectList.getByTestId("session-project-proj-shop")).toContainText("Shop");
  await expect(projectList.getByTestId("session-project-proj-old")).toContainText("Old Project");
  await projectList
    .getByTestId("session-project-proj-old")
    .getByTestId("session-project-toggle")
    .click();
  await expect(projectList.getByTestId("session-project-proj-old")).toContainText(
    "Old archived work",
  );
});

test("the Projects view follows the selected project scope", async ({ page }) => {
  const now = Date.now();
  const sessions = [
    liveFixture(now, 0, "Shop work", "proj-shop", 1),
    liveFixture(now, 1, "Billing work", "proj-billing", 2),
  ];
  await stubSessionRoutes(page, sessions, [
    { id: "proj-shop", name: "Shop", scope: "/fixture/shop", status: "active" },
    { id: "proj-billing", name: "Billing", scope: "/fixture/billing", status: "active" },
  ]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tasks?chat=full&project=proj-shop");
  await openChatHistory(page);
  await relaxList(page);
  await page.getByTestId("session-navigation-projects").click();
  const projectList = page.getByTestId("session-project-list");
  await expect(projectList.getByTestId("session-project-proj-shop")).toContainText("Shop");
  await expect(projectList.getByTestId("session-project-proj-billing")).toHaveCount(0);
  await expect(projectList.getByTestId("session-project-unassigned")).toHaveCount(0);
});

test("the chosen session section persists across reloads", async ({ page }) => {
  const now = Date.now();
  await page.addInitScript(() => {
    localStorage.setItem("orc_chat_history_section", "projects");
  });
  await stubSessionRoutes(
    page,
    [liveFixture(now, 0, "Shop work", "proj-shop", 1)],
    [{ id: "proj-shop", name: "Shop", scope: "/fixture/shop", status: "active" }],
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tasks?chat=full");
  await openChatHistory(page);
  await expect(page.getByTestId("session-navigation-projects")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId("session-project-list")).toBeVisible();
});

test("the per-project new-session button starts a chat in that project", async ({ page }) => {
  const now = Date.now();
  await stubSessionRoutes(
    page,
    [liveFixture(now, 0, "Shop work", "proj-shop", 1)],
    [{ id: "proj-shop", name: "Shop", scope: "/fixture/shop", status: "active" }],
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tasks?chat=full");
  await openChatHistory(page);
  await relaxList(page);
  await page.getByTestId("session-navigation-projects").click();
  const group = page.getByTestId("session-project-list").getByTestId("session-project-proj-shop");
  await group.hover();
  await group.getByTestId("session-project-new").click();
  await expect(page.getByTestId("session-project-breadcrumb").filter({ visible: true })).toHaveText(
    "Shop",
  );
});
