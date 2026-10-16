import { expect, test } from "@playwright/test";
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
  page.on("request", (event) => {
    if (new URL(event.url()).pathname.startsWith("/api/"))
      requests.push(new URL(event.url()).pathname);
  });
  for (const tab of [page, second]) {
    await gotoView(tab, "tasks");
    await selectProject(tab, project.id);
    await tab.getByTestId("tasks-view-table").click();
    await expect(tab.getByTestId("task-row")).toHaveCount(1);
  }
  await page.waitForTimeout(700);
  expect(requests.filter((path) => path === "/api/events")).toHaveLength(1);
  const baseline = requests.length;
  await page.waitForTimeout(6500);
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
