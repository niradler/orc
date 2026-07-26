import { expect, test } from "@playwright/test";
import { apiDelete, apiGet, apiPost, gotoView, tid } from "./_helpers";

interface Backend {
  name: string;
  kind: "in-process" | "cli" | "http";
  available: boolean;
  error: string | null;
  requires: string;
  target: string | null;
  source: string | null;
}

interface Task {
  id: string;
  agent_backend: string | null;
}

test.describe("Agent backends", () => {
  test("the API reports every backend with a usable verdict", async ({ request }) => {
    const { backends, default_backend } = await apiGet<{
      backends: Backend[];
      default_backend: string;
    }>(request, "/backends");

    const names = backends.map((b) => b.name);
    expect(names).toContain("claude");
    expect(names).toContain("acpx");
    expect(names).toContain("agentapi");
    expect(names).toContain("codex-cli");
    expect(names).toContain(default_backend);

    // The split that decides whether a user has to install anything.
    expect(backends.find((b) => b.name === "claude")?.kind).toBe("in-process");
    expect(backends.find((b) => b.name === "acpx")?.kind).toBe("cli");

    // Every unusable backend has to say why, or the UI has nothing to show.
    for (const backend of backends) {
      if (!backend.available) expect(backend.error, `${backend.name} error`).toBeTruthy();
    }
  });

  test("acpx is found without being on PATH", async ({ request }) => {
    const { backends } = await apiGet<{ backends: Backend[] }>(request, "/backends");
    const acpx = backends.find((b) => b.name === "acpx");
    // acpx ships as an optionalDependency, so a plain install resolves it from
    // the package's own node_modules rather than needing a global install.
    expect(acpx?.available).toBe(true);
    expect(acpx?.target).toContain("acpx");
    expect(["path", "bundled", "config"]).toContain(acpx?.source);
  });

  test("the create dialog offers the probed backends and marks readiness", async ({
    page,
    request,
  }) => {
    const { backends } = await apiGet<{ backends: Backend[] }>(request, "/backends");
    await gotoView(page, "tasks");
    await page.getByTestId("new-task-button").click();

    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("new-task-backend").click();

    // One option per probed backend, plus the "Default (…)" entry.
    await expect(page.getByRole("option")).toHaveCount(backends.length + 1);
    const claudeOption = page.getByRole("option", { name: /^claude ●/ });
    await expect(claudeOption).toBeVisible();
    // An unusable backend is offered but visibly marked, rather than hidden.
    await expect(page.getByRole("option", { name: /^codex-cli ○/ })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog.getByTestId("backend-picker-hint")).not.toHaveText("");
  });

  test("picking a backend writes agent_backend on the task", async ({ page, request }) => {
    const title = tid("pw-backend");
    await gotoView(page, "tasks");
    await page.getByTestId("new-task-button").click();

    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("task-title-input").fill(title);
    await dialog.getByTestId("new-task-backend").click();
    await page.getByRole("option", { name: /^acpx / }).click();
    await dialog.getByTestId("task-submit").click();

    let created: Task | undefined;
    try {
      await expect
        .poll(
          async () => {
            const { tasks } = await apiGet<{ tasks: Task[] }>(request, "/tasks?limit=100");
            created = tasks.find((t) => t.agent_backend === "acpx");
            return created !== undefined;
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    } finally {
      if (created) await apiDelete(request, `/tasks/${created.id}`);
    }
  });

  test("the task sheet names the backend a task will run on", async ({ page, request }) => {
    const task = await apiPost<Task>(request, "/tasks", {
      title: tid("pw-backend-detail"),
      status: "todo",
      priority: "normal",
    });
    try {
      const { default_backend } = await apiGet<{ default_backend: string }>(request, "/backends");
      await gotoView(page, "tasks");
      await page.goto(`/tasks/${task.id}`);
      // No agent_backend on the task means the configured default, named.
      await expect(page.getByTestId("task-backend-name")).toHaveText(
        `${default_backend} (default)`,
      );
    } finally {
      await apiDelete(request, `/tasks/${task.id}`);
    }
  });
});
