import { ChatSettingsSchema, type ChatThread } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { captureState } from "./_capture-state";
import { closeChatHistory, openChatHistory } from "./_chat-ui";
import { API_SECRET } from "./_helpers";

test("session history scopes assigned sources and local drafts without inventing legacy ownership", async ({
  page,
}, info) => {
  const now = Date.now();
  const scopes = ["p1", "p2", null];
  const summaries = scopes.map((project, index) => ({
    id: `90000000-0000-4000-8000-00000000000${index + 1}`,
    title: `Saved ${project ?? "unassigned"}`,
    agent: "codex",
    runtimeId: `native-${index}`,
    sourceId: `source-${index}`,
    host: null,
    running: false,
    updatedAt: now - index * 1000,
  }));
  const legacy = {
    id: "90000000-0000-4000-8000-000000000009",
    title: "Legacy unknown ownership",
    agent: "claude",
    running: false,
    updatedAt: now - 9000,
  };
  const live = summaries.map((summary, index) => ({
    id: summary.sourceId,
    session_id: summary.runtimeId,
    agent: "codex",
    name: `Native ${scopes[index]}`,
    project_id: scopes[index],
    host: null,
    cwd: "/fixture",
    status: "stopped",
    last_activity_at: new Date(summary.updatedAt).toISOString(),
    created_at: new Date(summary.updatedAt).toISOString(),
  }));
  const archives = scopes.map((project, index) => ({
    id: `archive-${index}`,
    project_id: project,
    native_id: `archive-native-${index}`,
    source_id: "fixture",
    agent: "claude",
    title: `Archive ${project ?? "unassigned"}`,
    metadata: {},
    revision: 1,
    created_at: new Date(now - 5000 - index).toISOString(),
    updated_at: new Date(now - 5000 - index).toISOString(),
  }));
  const observed: Array<{ kind: string; scope: string | null }> = [];
  await page.addInitScript((secret) => {
    localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
    localStorage.setItem("orc_selected_project", "p1");
  }, API_SECRET);
  await page.route(/\/api\/projects(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        projects: [
          { id: "p1", name: "Project one", status: "active" },
          { id: "p2", name: "Project two", status: "active" },
        ],
      },
    }),
  );
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await page.route("**/api/chat/threads", (route) =>
    route.fulfill({ json: { threads: [...summaries, legacy] } }),
  );
  await page.route("**/api/chat/threads/*/live", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
  await page.route(`**/api/chat/threads/${summaries[0].id}`, (route) => {
    const thread: ChatThread = {
      id: summaries[0].id,
      title: summaries[0].title,
      config: ChatSettingsSchema.parse({ agent: "codex" }),
      cwd: "/fixture",
      host: null,
      runtimeId: summaries[0].runtimeId,
      sourceId: summaries[0].sourceId,
      backend: "codex-cli",
      updatedAt: now,
      messages: [],
    };
    return route.fulfill({ json: thread });
  });
  for (const kind of ["live", "archive"] as const) {
    await page.route(`**/api/sessions/${kind}?**`, (route) => {
      const scope = new URL(route.request().url()).searchParams.get("project_id");
      if (
        kind === "archive" ||
        new URL(route.request().url()).searchParams.get("active") === "false"
      )
        observed.push({ kind, scope });
      const rows = kind === "live" ? live : archives;
      return route.fulfill({
        json: {
          sessions: rows.filter(
            (row) =>
              !scope ||
              (scope === "unassigned" ? row.project_id === null : row.project_id === scope),
          ),
          has_more: false,
        },
      });
    });
  }
  async function selectProject(id: string) {
    await page.getByTestId("sidebar-project-select").filter({ visible: true }).click();
    await page.getByTestId(`project-option-${id}`).click();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tasks?chat=open");
  await page.getByTestId("chat-input").fill("Project one unsent draft");
  await openChatHistory(page);
  const list = page.getByTestId("chat-session-list");
  const row = (id: string) => list.locator(`[data-history-id="${id}"]`);
  await expect(row(`chat:${summaries[0].id}`)).toBeVisible();
  await expect(row("archive:archive-0")).toBeVisible();
  await expect(list.locator('[data-history-id^="draft:"]')).toHaveCount(1);
  await expect(row(`chat:${legacy.id}`)).toHaveCount(0);
  await expect(row(`chat:${summaries[1].id}`)).toHaveCount(0);
  await captureState(page, {
    path: info.outputPath("chat-project-p1.png"),
    animations: "disabled",
  });
  await row(`chat:${summaries[0].id}`).getByTestId("chat-resume-thread").click();
  await closeChatHistory(page);
  await selectProject("p2");
  await expect(page.getByTestId("chat-agent-button")).toContainText("codex");
  await openChatHistory(page);
  await expect(row(`chat:${summaries[1].id}`)).toBeVisible();
  await expect(row(`chat:${summaries[0].id}`)).toHaveCount(0);
  await expect(list.locator('[data-history-id^="draft:"]')).toHaveCount(0);
  await closeChatHistory(page);
  await page.getByTestId("chat-clear-button").click();
  await page.getByTestId("chat-input").fill("Project two unsent draft");
  await selectProject("p1");
  await expect(page.getByTestId("chat-input")).toHaveValue("Project two unsent draft");
  await openChatHistory(page);
  await list.locator('[data-history-id^="draft:"]').getByTestId("chat-session-select").click();
  await closeChatHistory(page);
  await expect(page.getByTestId("chat-input")).toHaveValue("Project one unsent draft");
  await selectProject("unassigned");
  await openChatHistory(page);
  await expect(row(`chat:${legacy.id}`)).toHaveCount(0);
  await expect(row(`chat:${summaries[2].id}`)).toBeVisible();
  await expect(row("archive:archive-2")).toBeVisible();
  await expect(row(`chat:${summaries[0].id}`)).toHaveCount(0);
  await expect(list.locator('[data-history-id^="draft:"]')).toHaveCount(0);
  await closeChatHistory(page);
  await page.getByTestId("chat-clear-button").click();
  await page.getByTestId("chat-input").fill("Explicitly unassigned draft");
  await openChatHistory(page);
  await expect(list.locator('[data-history-id^="draft:"]')).toHaveCount(1);
  await closeChatHistory(page);
  expect(observed.every((row) => row.scope !== null)).toBe(true);
  await selectProject("all");
  await openChatHistory(page);
  await expect(row(`chat:${legacy.id}`)).toBeVisible();
  for (const summary of summaries) await expect(row(`chat:${summary.id}`)).toHaveCount(1);
  await expect(list.locator('[data-history-id^="draft:"]')).toHaveCount(3);
  await closeChatHistory(page);
  await selectProject("p1");
  await openChatHistory(page);
  await row(`chat:${summaries[0].id}`).getByTestId("chat-session-select").click();
  await closeChatHistory(page);
  await expect
    .poll(() =>
      page.evaluate(
        (id) => JSON.parse(localStorage.getItem("orc_chat_tabs") ?? "{}").projectIds?.[id],
        summaries[0].id,
      ),
    )
    .toBe("p1");
  await page.reload();
  await expect(page.getByTestId("chat-agent-button")).toContainText("codex");
  await openChatHistory(page);
  await expect(row(`chat:${summaries[0].id}`)).toHaveCount(1);
  for (const kind of ["live", "archive"])
    for (const scope of ["p1", "p2", "unassigned", null])
      expect(observed).toContainEqual({ kind, scope });
});
