import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { apiDelete, apiGet, apiPost, gotoView, repoRoot, tid } from "./_helpers";

// Project flows live in `<cwd>/.orc/flows/<name>/flow.json` and the API under
// test runs with the repo root as its cwd, so these fixtures put a project flow
// exactly where a real repo would. `.orc/` is gitignored, and afterAll removes
// them - `?reload=true` is what makes the server re-scan the directory.
const PROJECT_FLOWS = join(repoRoot(), ".orc", "flows");

/** Shadows a builtin, which is what puts a "shadows builtin" badge on the row. */
const SHADOWING_FLOW = {
  name: "orc-review-only",
  description: "Project override used by the Playwright suite",
  entry: "review",
  nodes: {
    review: {
      kind: "human",
      prompt: "Look at it yourself",
      task_status: "review",
    },
    done: { kind: "terminal", task_status: "done" },
  },
  edges: [{ from: "review", to: "done", when: { always: true }, label: "reviewed" }],
};

/** `lessThan` is not a comparator, so the definition is rejected on load. */
const BROKEN_FLOW = {
  name: "pw-broken-flow",
  description: "Invalid on purpose",
  entry: "build",
  nodes: {
    build: { kind: "agent", skill: "whatever" },
    done: { kind: "terminal", task_status: "done" },
  },
  edges: [{ from: "build", to: "done", when: { visits: { lessThan: 3 } } }],
};

function writeProjectFlow(definition: { name: string }): void {
  const dir = join(PROJECT_FLOWS, definition.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "flow.json"), JSON.stringify(definition, null, 2));
}

/** Opens the new-task dialog, where the flow picker lives. */
async function openNewTaskDialog(page: Page) {
  await gotoView(page, "tasks");
  await page.getByTestId("new-task-button").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Execution", exact: true }).click();
  return dialog;
}

test.describe("Flow picker", () => {
  test.beforeAll(async ({ request }) => {
    writeProjectFlow(SHADOWING_FLOW);
    writeProjectFlow(BROKEN_FLOW);
    await apiGet(request, "/flows?reload=true");
  });

  test.afterAll(async ({ request }) => {
    rmSync(join(PROJECT_FLOWS, SHADOWING_FLOW.name), {
      recursive: true,
      force: true,
    });
    rmSync(join(PROJECT_FLOWS, BROKEN_FLOW.name), {
      recursive: true,
      force: true,
    });
    await apiGet(request, "/flows?reload=true");
  });

  test("built-in flows are offered with their source, and the default is named", async ({
    page,
  }) => {
    const dialog = await openNewTaskDialog(page);
    await dialog.getByTestId("new-task-flow").click();

    await expect(page.getByRole("option", { name: /^Default \(orc-default\)/ })).toBeVisible();
    await expect(page.getByTestId("flow-option-orc-human-review")).toContainText(
      "Development with human sign-off",
    );
    await expect(page.getByTestId("flow-option-orc-default")).toContainText("Development");
    await expect(page.getByTestId("flow-option-orc-parallel-review")).toHaveCount(0);
  });

  test("a project flow shadowing a builtin says so", async ({ page }) => {
    const dialog = await openNewTaskDialog(page);
    await dialog.getByTestId("new-task-flow").click();
    await page.getByRole("option", { name: `${SHADOWING_FLOW.name} · project` }).click();
    await expect(dialog.getByTestId("flow-picker-hint")).toContainText("shadows the builtin flow");
  });

  test("invalid definitions are surfaced with their validation errors", async ({ page }) => {
    const dialog = await openNewTaskDialog(page);
    const panel = dialog.getByTestId("broken-flows");
    await expect(panel).toBeVisible();
    await panel.locator("summary").click();

    const broken = panel.locator(
      `[data-testid="broken-flow-row"][data-flow-name="${BROKEN_FLOW.name}"]`,
    );
    await expect(broken).toBeVisible();
    await expect(broken.getByTestId("broken-flow-error").first()).toBeVisible();
    // The error text names the offending path, not just "invalid".
    await expect(broken).toContainText(/edges/i);
  });

  test("View flow renders the selected flow's graph, nodes and edges", async ({ page }) => {
    const dialog = await openNewTaskDialog(page);
    // With no explicit choice the picker resolves to the configured default.
    await dialog.getByTestId("flow-picker-view").click();

    const detail = page.getByTestId("flow-detail");
    await expect(detail).toBeVisible();

    const graph = detail.getByTestId("flow-graph");
    await expect(graph).toHaveAttribute("data-flow-name", "orc-default");
    // orc-default: build, review_gate, review, done, blocked_out, escalated.
    await expect(graph.locator('[data-testid="flow-graph-node"]')).toHaveCount(6);
    await expect(graph.locator('[data-node-id="build"]')).toBeVisible();

    // The review → build rework edge returns to an earlier node: the layout has
    // to classify it as a loopback, or the picture hides the loop.
    const loopback = graph.locator(
      '[data-testid="flow-graph-edge"][data-edge-from="review"][data-edge-to="build"]',
    );
    await expect(loopback).toHaveAttribute("data-edge-kind", "back");

    // Edge list mirrors the definition's order, conditions rendered as prose.
    await expect(detail.locator('[data-testid="flow-detail-edge"]')).toHaveCount(7);
    await expect(detail.locator('[data-testid="flow-detail-edge"]').first()).toContainText(
      "outcome submitted",
    );
    await expect(detail.locator('[data-testid="flow-detail-node"]')).toHaveCount(6);
  });

  test("View flow follows the picked flow", async ({ page }) => {
    const dialog = await openNewTaskDialog(page);
    await dialog.getByTestId("new-task-flow").click();
    await page.getByTestId("flow-option-orc-human-review").click();
    await dialog.getByTestId("flow-picker-view").click();
    await expect(page.getByTestId("flow-detail").getByTestId("flow-graph")).toHaveAttribute(
      "data-flow-name",
      "orc-human-review",
    );
    await expect(
      page
        .getByTestId("flow-detail")
        .locator('[data-testid="flow-detail-node"][data-node-id="signoff"]'),
    ).toContainText("Human approves delivery");
  });
  test("a running named flow opens its definition from the task", async ({ page, request }) => {
    // The project override is a single human gate, so starting it spawns no agent.
    const task = await apiPost<{ id: string }>(request, "/tasks", {
      title: tid("pw-flow-view"),
      status: "todo",
      priority: "normal",
    });
    try {
      await apiPost(request, `/tasks/${task.id}/flow`, { name: SHADOWING_FLOW.name, start: true });
      await gotoView(page, "tasks");
      await page.goto(`/tasks/${task.id}`);

      await page.getByTestId("flow-run-name").click();
      const detail = page.getByTestId("flow-detail");
      await expect(detail).toBeVisible();
      await expect(detail.getByTestId("flow-graph")).toHaveAttribute(
        "data-flow-name",
        SHADOWING_FLOW.name,
      );
      await expect(detail.locator('[data-testid="flow-detail-node"]')).toHaveCount(2);
    } finally {
      await apiDelete(request, `/tasks/${task.id}`);
    }
  });
});
