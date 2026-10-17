import { expect, type Page, test } from "@playwright/test";
import {
  API_BASE,
  AUTH_HEADERS,
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  gotoView,
  tid,
} from "./_helpers";

interface Project {
  id: string;
  name: string;
}
interface Memory {
  project_id: string;
  name: string;
  description: string;
  content: string;
  priority: number | null;
}

async function createProject(request: import("@playwright/test").APIRequestContext) {
  return apiPost<Project>(request, "/projects", { name: tid("pw-mem-project") });
}

function memoryName(prefix: string): string {
  return tid(prefix).toLowerCase();
}

async function openMemories(page: Page, projectId: string, extra = ""): Promise<void> {
  // gotoView installs the API secret before the first load.
  await gotoView(page, "memories");
  await page.goto(`/knowledge/memories?project=${encodeURIComponent(projectId)}${extra}`);
  await expect(page.getByTestId("view-title")).toHaveText("Memories");
}

function row(page: Page, name: string) {
  return page.locator(`[data-testid="memory-row"][data-memory-name="${name}"]`);
}

test.describe("Memories", () => {
  test("create, edit, revert and delete a memory from the UI", async ({ page, request }) => {
    const project = await createProject(request);
    const name = memoryName("pw-mem");
    try {
      await openMemories(page, project.id);
      await page.getByTestId("new-memory-button").click();
      const dialog = page.getByTestId("memory-form-dialog");
      await dialog.getByTestId("memory-name-input").fill(name);
      await dialog.getByTestId("memory-description-input").fill("API port for local dev");
      await expect(dialog.getByTestId("memory-description-count")).toHaveText("22/300");

      // Content over the cap is rejected by the server, which says to make it a skill.
      await dialog.getByTestId("memory-content-input").fill("x".repeat(801));
      await expect(dialog.getByTestId("memory-content-count")).toHaveText("801/800");
      await dialog.getByTestId("memory-submit").click();
      await expect(dialog.getByTestId("memory-form-error")).toContainText(/skill/i);

      await dialog.getByTestId("memory-content-input").fill("The API listens on 7711.");
      await dialog.getByTestId("memory-priority-input").fill("70");
      await dialog.getByTestId("memory-submit").click();
      await expect(dialog).toHaveCount(0);

      // Creating opens the new memory, addressed by project and name.
      await expect(page).toHaveURL(
        new RegExp(`/knowledge/memories/${project.id}/${name}\\?project=${project.id}`),
      );
      const detail = page.getByTestId("memory-detail");
      await expect(detail.getByTestId("memory-detail-content")).toHaveText(
        "The API listens on 7711.",
      );
      await expect(detail.getByTestId("memory-priority")).toHaveText("P70");
      await expect(detail.getByTestId("memory-detail-author")).toHaveText("human");
      await expect(row(page, name)).toBeVisible();

      await detail.getByTestId("memory-edit").click();
      await expect(dialog.getByTestId("memory-name-input")).toHaveCount(0);
      await dialog.getByTestId("memory-content-input").fill("The API listens on 7700.");
      await dialog.getByTestId("memory-priority-input").fill("");
      await dialog.getByTestId("memory-reason-input").fill("Port moved");
      await dialog.getByTestId("memory-submit").click();
      await expect(dialog).toHaveCount(0);
      await expect(detail.getByTestId("memory-detail-content")).toHaveText(
        "The API listens on 7700.",
      );
      await expect(detail.getByTestId("memory-priority")).toHaveText("Unscored");
      await expect(detail.getByTestId("memory-history-change")).toHaveCount(2);
      await expect(detail.getByTestId("memory-history-change").first()).toContainText("Port moved");

      // Restore the state before the edit; the latest change id guards the revert.
      await detail.getByTestId("memory-revert-reason").fill("Port did not move");
      const latest = detail.getByTestId("memory-history-change").first();
      await latest.locator("summary").click();
      await latest.getByTestId("memory-revert-change").click();
      await expect(detail.getByTestId("memory-detail-content")).toHaveText(
        "The API listens on 7711.",
      );
      await expect(detail.getByTestId("memory-priority")).toHaveText("P70");
      await expect(detail.getByTestId("memory-history-change")).toHaveCount(3);
      const stored = await apiGet<Memory>(
        request,
        `/memories/${name}?project_id=${encodeURIComponent(project.id)}`,
      );
      expect(stored.content).toBe("The API listens on 7711.");
      expect(stored.priority).toBe(70);

      await detail.getByTestId("memory-delete").click();
      await page.getByTestId("confirm-dialog-confirm").click();
      await expect(detail).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/knowledge/memories\\?project=${project.id}$`));
      await expect(row(page, name)).toHaveCount(0);
    } finally {
      await apiDelete(request, `/projects/${project.id}`);
    }
  });

  test("lists by reads, recency or priority, searches, and counts reads per source", async ({
    page,
    request,
  }) => {
    const project = await createProject(request);
    const popular = memoryName("pw-popular");
    const important = memoryName("pw-important");
    const unscored = memoryName("pw-unscored");
    try {
      for (const [name, priority] of [
        [popular, 10],
        [important, 90],
        [unscored, null],
      ] as const)
        await apiPost(request, "/memories", {
          project_id: project.id,
          name,
          description: `${name} description`,
          content: `${name} content`,
          priority,
        });
      // One CLI read and one plain API read; both are agent reads.
      for (const client of ["cli", undefined]) {
        const res = await request.get(
          `${API_BASE}/memories/${popular}?project_id=${encodeURIComponent(project.id)}`,
          { headers: client ? { ...AUTH_HEADERS, "X-Orc-Source": client } : AUTH_HEADERS },
        );
        expect(res.ok()).toBe(true);
      }
      await openMemories(page, project.id);
      await expect(page.getByTestId("view-meta")).toHaveText("3 memories");
      await expect(page.getByTestId("memory-sort-reads")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("memory-row").first()).toHaveAttribute(
        "data-memory-name",
        popular,
      );
      await expect(row(page, popular).getByTestId("memory-read-count")).toHaveText("2");
      await expect(row(page, popular).getByTestId("memory-read-count")).toHaveAttribute(
        "title",
        new RegExp(`mcp 0 · cli 1 · api 1 · ui 0 · last read .*${new Date().getFullYear()}`),
      );
      await expect(row(page, unscored).getByTestId("memory-priority")).toHaveText("Unscored");

      await page.getByTestId("memory-sort-priority").click();
      await expect(page).toHaveURL(/memorySort=priority/);
      await expect(page.getByTestId("memory-row").first()).toHaveAttribute(
        "data-memory-name",
        important,
      );
      await expect(row(page, important).getByTestId("memory-priority")).toHaveText("P90");

      // Recent ranks by last read or update; an update moves a memory to the top.
      await apiPatch(request, `/memories/${unscored}`, {
        project_id: project.id,
        description: "Updated just now",
      });
      await page.getByTestId("memory-sort-recent").click();
      await expect(page.getByTestId("memory-row").first()).toHaveAttribute(
        "data-memory-name",
        unscored,
      );

      await page.getByTestId("memory-search-input").fill(important);
      await page.getByTestId("memory-search-input").press("Enter");
      await expect(page.getByTestId("memory-row")).toHaveCount(1);
      await expect(row(page, important)).toBeVisible();
      // Search covers descriptions too.
      await page.getByTestId("memory-search-input").fill("Updated just now");
      await page.getByTestId("memory-search-input").press("Enter");
      await expect(page.getByTestId("memory-row")).toHaveCount(1);
      await expect(row(page, unscored)).toBeVisible();
    } finally {
      await apiDelete(request, `/projects/${project.id}`);
    }
  });

  test("project selector scopes the list and new memories need a project", async ({
    page,
    request,
  }) => {
    const first = await createProject(request);
    const second = await createProject(request);
    const shared = memoryName("pw-shared");
    try {
      for (const project of [first, second])
        await apiPost(request, "/memories", {
          project_id: project.id,
          name: shared,
          description: `${shared} in ${project.name}`,
          content: "Same name, different project",
        });
      await openMemories(page, first.id);
      await expect(page.getByTestId("memory-row")).toHaveCount(1);
      await expect(row(page, shared)).toHaveAttribute("data-memory-project", first.id);

      await page.getByTestId("memory-project-filter").click();
      await page.getByTestId(`memory-project-option-${second.id}`).click();
      await expect(page).toHaveURL(new RegExp(`project=${second.id}`));
      await expect(row(page, shared)).toHaveAttribute("data-memory-project", second.id);

      await page.goto(`/knowledge/memories?project=all&memoryQuery=${shared}`);
      await expect(page.getByTestId("memory-row")).toHaveCount(2);
      await page
        .locator(
          `[data-testid="memory-row"][data-memory-name="${shared}"][data-memory-project="${second.id}"]`,
        )
        .click();
      await expect(page.getByTestId("memory-detail-description")).toHaveText(
        `${shared} in ${second.name}`,
      );
      await page.keyboard.press("Escape");

      await page.getByTestId("new-memory-button").click();
      const dialog = page.getByTestId("memory-form-dialog");
      await dialog.getByTestId("memory-name-input").fill(memoryName("pw-needs-project"));
      await dialog.getByTestId("memory-description-input").fill("Needs a project");
      await dialog.getByTestId("memory-content-input").fill("Chosen in the dialog");
      await expect(dialog.getByTestId("memory-submit")).toBeDisabled();
      await dialog.getByTestId("memory-project-select").click();
      await page.getByRole("option", { name: first.name }).click();
      await expect(dialog.getByTestId("memory-submit")).toBeEnabled();
    } finally {
      await apiDelete(request, `/projects/${first.id}`);
      await apiDelete(request, `/projects/${second.id}`);
    }
  });

  test("agent writes and reads update an open list live", async ({ page, request }) => {
    const project = await createProject(request);
    const name = memoryName("pw-live");
    try {
      await openMemories(page, project.id);
      await expect(page.getByText("No memories yet")).toBeVisible();
      await apiPost(request, "/memories", {
        project_id: project.id,
        name,
        description: "Written by an agent",
        content: "Live update",
      });
      await expect(row(page, name)).toBeVisible();
      await expect(row(page, name).getByTestId("memory-read-count")).toHaveText("0");
      const res = await request.get(
        `${API_BASE}/memories/${name}?project_id=${encodeURIComponent(project.id)}`,
        { headers: { ...AUTH_HEADERS, "X-Orc-Source": "cli" } },
      );
      expect(res.ok()).toBe(true);
      await expect(row(page, name).getByTestId("memory-read-count")).toHaveText("1");
    } finally {
      await apiDelete(request, `/projects/${project.id}`);
    }
  });
});
