import { expect, type Request, test } from "@playwright/test";
import {
  API_BASE,
  AUTH_HEADERS,
  apiPatch,
  apiPost,
  gotoView,
  selectProject,
  tid,
} from "./_helpers";

test("one shared stream keeps two tabs fresh, stays idle, and resynchronizes after reconnect", async ({
  page,
  context,
  request,
}) => {
  const project = await apiPost<{ id: string }>(request, "/projects", {
    name: tid("events-project"),
  });
  const created = await apiPost<{ id: string }>(request, "/tasks", {
    title: tid("events-task"),
    project_id: project.id,
  });
  const second = await context.newPage();
  const requests: string[] = [];
  const pending = new Set<Request>();
  let lastActivity = Date.now();
  page.on("request", (event) => {
    const path = new URL(event.url()).pathname;
    if (path.startsWith("/api/")) {
      requests.push(path);
      lastActivity = Date.now();
      if (path !== "/api/events") pending.add(event);
    }
  });
  const completed = (event: Request) => {
    if (pending.delete(event)) lastActivity = Date.now();
  };
  page.on("requestfinished", completed);
  page.on("requestfailed", completed);
  for (const tab of [page, second]) {
    await gotoView(tab, "tasks");
    await selectProject(tab, project.id);
    await tab.getByTestId("tasks-view-table").click();
    await expect(tab.getByTestId("task-row")).toHaveCount(1);
  }
  await expect.poll(() => pending.size === 0 && Date.now() - lastActivity >= 500).toBe(true);
  expect(requests.filter((path) => path === "/api/events")).toHaveLength(1);
  const baseline = requests.length;
  // Longer than the 15 s poll this used to return, so a reintroduced interval fails here.
  await page.waitForTimeout(17_000);
  expect(requests.slice(baseline)).toEqual([]);

  const title = tid("changed-outside-browser");
  await apiPatch(request, `/tasks/${created.id}`, { title });
  for (const tab of [page, second]) await expect(tab.getByTestId("task-row")).toContainText(title);

  await context.setOffline(true);
  await page.waitForTimeout(1000);
  const offlineTitle = tid("changed-while-offline");
  await apiPatch(request, `/tasks/${created.id}`, { title: offlineTitle });
  await context.setOffline(false);
  for (const tab of [page, second])
    await expect(tab.getByTestId("task-row")).toContainText(offlineTitle);
  expect(requests.filter((path) => path === "/api/events").length).toBeGreaterThan(1);
  await second.close();
});

test("terminal creation and removal arrive without an attached output socket", async ({
  page,
  request,
}) => {
  await gotoView(page, "terminals");
  await expect(page.getByTestId("terminals-list")).toBeVisible();
  const count = await page.getByTestId("terminal-item").count();
  const terminal = await apiPost<{ id: string }>(request, "/terminals", {
    kind: "shell",
    name: tid("unattached"),
  });
  try {
    await expect(page.getByTestId("terminal-item")).toHaveCount(count + 1);
  } finally {
    const response = await request.delete(`${API_BASE}/terminals/${terminal.id}`, {
      headers: AUTH_HEADERS,
    });
    expect(response.ok()).toBe(true);
  }
  await expect(page.getByTestId("terminal-item")).toHaveCount(count);
});
