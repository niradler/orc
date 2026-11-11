import { expect, type Page, type Request, test } from "@playwright/test";
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
  /** Records every /api request and whether the tab has been idle for a while. */
  const track = (tab: Page) => {
    const paths: string[] = [];
    const inFlight = new Set<Request>();
    let lastActivity = Date.now();
    tab.on("request", (event) => {
      const path = new URL(event.url()).pathname;
      if (!path.startsWith("/api/")) return;
      paths.push(path);
      lastActivity = Date.now();
      if (path !== "/api/events") inFlight.add(event);
    });
    const completed = (event: Request) => {
      if (inFlight.delete(event)) lastActivity = Date.now();
    };
    tab.on("requestfinished", completed);
    tab.on("requestfailed", completed);
    return {
      paths,
      pathsNamed: (name: string) => paths.filter((path) => path === name),
      idle: (ms: number) => inFlight.size === 0 && Date.now() - lastActivity >= ms,
    };
  };
  const first = track(page);
  const other = track(second);
  for (const tab of [page, second]) {
    await gotoView(tab, "tasks");
    await selectProject(tab, project.id);
    await tab.getByTestId("tasks-view-table").click();
    await expect(tab.getByTestId("task-row")).toHaveCount(1);
  }
  await expect.poll(() => first.idle(500) && other.idle(500)).toBe(true);
  expect(first.pathsNamed("/api/events")).toHaveLength(1);
  expect(other.pathsNamed("/api/events")).toHaveLength(1);
  const baseline = [first.paths.length, other.paths.length];
  // Longer than the 15 s poll this used to return, so a reintroduced interval fails here.
  await page.waitForTimeout(17_000);
  expect(first.paths.slice(baseline[0])).toEqual([]);
  expect(other.paths.slice(baseline[1])).toEqual([]);

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
  expect(first.pathsNamed("/api/events").length).toBeGreaterThan(1);
  await second.close();
});

test("a blocked event stream falls back to a slow refresh and recovers", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await page.clock.install();
  const project = await apiPost<{ id: string }>(request, "/projects", {
    name: tid("fallback-project"),
  });
  const created = await apiPost<{ id: string }>(request, "/tasks", {
    title: tid("fallback-task"),
    project_id: project.id,
  });
  const sources: string[] = [];
  const inFlight = new Set<Request>();
  let lastActivity = Date.now();
  page.on("request", (event) => {
    const path = new URL(event.url()).pathname;
    if (!path.startsWith("/api/") || path === "/api/events") return;
    sources.push(path);
    inFlight.add(event);
    lastActivity = Date.now();
  });
  const completed = (event: Request) => {
    if (inFlight.delete(event)) lastActivity = Date.now();
  };
  page.on("requestfinished", completed);
  page.on("requestfailed", completed);
  await page.route("**/api/events", (route) => route.abort());

  await gotoView(page, "tasks");
  await selectProject(page, project.id);
  await page.getByTestId("tasks-view-table").click();
  await expect(page.getByTestId("task-row")).toHaveCount(1);
  await expect(page.getByTestId("workspace-connection-status")).toContainText("Offline");
  await expect.poll(() => inFlight.size === 0 && Date.now() - lastActivity >= 500).toBe(true);
  const baseline = sources.length;

  // Connected tabs must not poll; only a disconnected stream enables the fallback.
  await page.clock.fastForward(5_000);
  expect(sources).toHaveLength(baseline);
  await page.clock.fastForward(26_000);
  await expect.poll(() => sources.length).toBeGreaterThan(baseline);

  // Unblocking the stream reconnects it; `ready` then refreshes and changes flow again.
  await page.unroute("**/api/events");
  await page.clock.fastForward(31_000);
  await expect(page.getByTestId("workspace-connection-status")).toContainText("Connected");
  const title = tid("fallback-recovered");
  await apiPatch(request, `/tasks/${created.id}`, { title });
  await expect(page.getByTestId("task-row")).toContainText(title);
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
