import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { apiGet, gotoView, repoRoot } from "./_helpers";

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

test.describe("Flows browser", () => {
  test.beforeAll(async ({ request }) => {
    writeProjectFlow(SHADOWING_FLOW);
    writeProjectFlow(BROKEN_FLOW);
    await apiGet(request, "/flows?reload=true");
  });

  test.afterAll(async ({ request }) => {
    rmSync(join(PROJECT_FLOWS, SHADOWING_FLOW.name), { recursive: true, force: true });
    rmSync(join(PROJECT_FLOWS, BROKEN_FLOW.name), { recursive: true, force: true });
    await apiGet(request, "/flows?reload=true");
  });

  test("built-in flows are listed with their source, and the default is marked", async ({
    page,
  }) => {
    await gotoView(page, "flows");
    await expect(page.getByTestId("view-title")).toHaveText(/flows/i);

    const row = page.locator('[data-testid="flow-row"][data-flow-name="orc-default"]');
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-flow-source", "builtin");
    await expect(row.getByTestId("flow-default-badge")).toBeVisible();

    // The fan-out flow is the one whose shape the graph has to handle; make sure
    // the list is really the shipped set and not a single row.
    await expect(
      page.locator('[data-testid="flow-row"][data-flow-name="orc-parallel-review"]'),
    ).toBeVisible();
  });

  test("a project flow shadowing a builtin says so", async ({ page }) => {
    await gotoView(page, "flows");
    const row = page.locator(`[data-testid="flow-row"][data-flow-name="${SHADOWING_FLOW.name}"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-flow-source", "project");
    await expect(row.getByTestId("flow-shadows-badge")).toContainText("shadows builtin");
  });

  test("source filter narrows the list to one source", async ({ page }) => {
    await gotoView(page, "flows");
    await page.getByTestId("flow-source-filter-project").click();

    const rows = page.locator('[data-testid="flow-row"]');
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toHaveAttribute("data-flow-source", "project");
    }
  });

  test("invalid definitions are surfaced with their validation errors", async ({ page }) => {
    await gotoView(page, "flows");
    const broken = page.locator(
      `[data-testid="broken-flow-row"][data-flow-name="${BROKEN_FLOW.name}"]`,
    );
    await expect(broken).toBeVisible();
    await expect(broken.getByTestId("broken-flow-error").first()).toBeVisible();
    // The error text names the offending path, not just "invalid".
    await expect(broken).toContainText(/edges/i);
  });

  test("opening a flow renders its graph, nodes and edges", async ({ page }) => {
    await gotoView(page, "flows");
    await page.locator('[data-testid="flow-row"][data-flow-name="orc-default"]').click();

    const sheet = page.getByRole("dialog");
    await expect(sheet.getByTestId("flow-detail")).toBeVisible();

    const graph = sheet.getByTestId("flow-graph");
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
    await expect(sheet.locator('[data-testid="flow-detail-edge"]')).toHaveCount(7);
    await expect(sheet.locator('[data-testid="flow-detail-edge"]').first()).toContainText(
      "outcome submitted",
    );
    await expect(sheet.locator('[data-testid="flow-detail-node"]')).toHaveCount(6);
  });

  test("a flow is addressable by URL", async ({ page }) => {
    await gotoView(page, "flows");
    await page.goto("/flows/orc-supervisor");
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByTestId("flow-detail")).toBeVisible();
    await expect(sheet.getByTestId("flow-graph")).toHaveAttribute(
      "data-flow-name",
      "orc-supervisor",
    );
  });
});
