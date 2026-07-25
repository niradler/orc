import type { APIRequestContext } from "@playwright/test";
import { expect, type Page, test } from "@playwright/test";
import { apiDelete, apiGet, apiPatch, apiPost, gotoView, tid } from "./_helpers";

interface Task {
  id: string;
  status: string;
  flow_name?: string | null;
}

interface FlowRunResponse {
  status: string;
  halt_reason: string | null;
  nodes: Array<{ node_id: string; status: string; outcome: string | null }>;
}

/**
 * A gate-only graph: `human` and `terminal` nodes run no agents, so a run can be
 * started, parked, resumed and halted with nothing but the API - no worker, no
 * model, no gateway session. The outcomes are deliberately *not* declared on the
 * node, so both the API and the UI have to derive them from the outgoing edges.
 */
function gateFlow(name: string) {
  return {
    name,
    description: "Playwright fixture: park on a human gate",
    entry: "sign_off",
    limits: { max_node_executions: 8 },
    nodes: {
      sign_off: {
        kind: "human",
        prompt: "Sign this off, or send it back.",
        task_status: "review",
      },
      shipped: { kind: "terminal", task_status: "done" },
      sent_back: { kind: "terminal", task_status: "blocked" },
    },
    edges: [
      { from: "sign_off", to: "shipped", when: { outcome: "ship_it" }, label: "ship it" },
      { from: "sign_off", to: "sent_back", when: { outcome: "send_back" }, label: "send back" },
    ],
  };
}

/**
 * The only edge out of the gate is guarded by a var the run never sets, so
 * whatever the human answers, nothing matches and the run halts with
 * `no_matching_edge`. Declaring an unroutable outcome instead is impossible -
 * flow validation rejects that definition outright.
 *
 * It also has no outcome conditions at all, so no outcome list can be derived:
 * the API accepts any outcome for this node, and the gate form has to ask for
 * one rather than offer a menu.
 */
function deadEndFlow(name: string) {
  return {
    name,
    description: "Playwright fixture: an outcome the graph cannot route",
    entry: "sign_off",
    nodes: {
      sign_off: { kind: "human", prompt: "Sign off", task_status: "review" },
      shipped: { kind: "terminal", task_status: "done" },
    },
    edges: [
      {
        from: "sign_off",
        to: "shipped",
        when: { var: "impossible", eq: true },
        label: "never matches",
      },
    ],
  };
}

async function createTask(
  request: APIRequestContext,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<Task> {
  return apiPost<Task>(request, "/tasks", { title, status: "todo", priority: "normal", ...extra });
}

async function openTask(page: Page, taskId: string): Promise<void> {
  await gotoView(page, "tasks");
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByRole("dialog")).toBeVisible();
}

async function pickOutcome(page: Page, outcome: string): Promise<void> {
  await page.getByTestId("flow-gate-outcome").click();
  await page.getByRole("option", { name: outcome, exact: true }).click();
}

test.describe("Task flow run panel", () => {
  test("a task that never ran a flow shows the flow it would run", async ({ page, request }) => {
    const task = await createTask(request, tid("pw-flow-none"));
    try {
      const { default_flow } = await apiGet<{ default_flow: string }>(request, "/flows");
      await openTask(page, task.id);

      await expect(page.getByTestId("flow-run-empty")).toBeVisible();
      // No flow_name on the task means the configured default, named explicitly.
      await expect(page.getByTestId("task-flow-name")).toHaveText(`${default_flow} (default)`);
    } finally {
      await apiDelete(request, `/tasks/${task.id}`);
    }
  });

  test("a named flow set on the task is shown as-is", async ({ page, request }) => {
    const task = await createTask(request, tid("pw-flow-named"), {
      flow_name: "orc-fix-verify",
    });
    try {
      await openTask(page, task.id);
      await expect(page.getByTestId("task-flow-name")).toHaveText("orc-fix-verify");
    } finally {
      await apiDelete(request, `/tasks/${task.id}`);
    }
  });

  test("the flow picker writes flow_name on create", async ({ page, request }) => {
    const title = tid("pw-flow-picked");
    await gotoView(page, "tasks");
    await page.getByTestId("new-task-button").click();

    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("task-title-input").fill(title);
    await dialog.getByTestId("new-task-flow").click();
    await page.getByRole("option", { name: /^orc-supervisor/ }).click();
    await dialog.getByTestId("task-submit").click();

    let created: Task | undefined;
    try {
      await expect
        .poll(
          async () => {
            const { tasks } = await apiGet<{ tasks: Task[] }>(request, "/tasks?limit=100");
            created = tasks.find((t) => t.id && t.flow_name === "orc-supervisor");
            return tasks.some((t) => t.flow_name === "orc-supervisor");
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    } finally {
      if (created) await apiDelete(request, `/tasks/${created.id}`);
    }
  });

  test("human gate: graph, ledger, and resume with a derived outcome", async ({
    page,
    request,
  }) => {
    const task = await createTask(request, tid("pw-flow-gate"));
    try {
      await apiPost(request, `/tasks/${task.id}/flow`, {
        definition: gateFlow("pw-gate"),
        start: true,
      });

      await openTask(page, task.id);
      const panel = page.getByTestId("flow-run-panel");
      await expect(panel).toHaveAttribute("data-flow-status", "running");
      await expect(page.getByTestId("flow-run-name")).toHaveText("pw-gate");

      // The parked node is drawn as awaiting_human; the terminals are untouched.
      await expect(
        page.locator('[data-testid="flow-graph-node"][data-node-id="sign_off"]'),
      ).toHaveAttribute("data-node-state", "awaiting_human");
      await expect(
        page.locator('[data-testid="flow-graph-node"][data-node-id="shipped"]'),
      ).toHaveAttribute("data-node-state", "idle");

      // Offered outcomes come from the node's outgoing edges, not a hardcoded list.
      await page.getByTestId("flow-gate-outcome").click();
      await expect(page.getByRole("option")).toHaveCount(2);
      await expect(page.getByRole("option", { name: "ship_it", exact: true })).toBeVisible();
      await expect(page.getByRole("option", { name: "send_back", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");

      await pickOutcome(page, "send_back");
      await page.getByTestId("flow-gate-comment").fill("not ready, sending it back");
      await page.getByTestId("flow-gate-submit").click();

      // The graph reached the sent_back terminal, so the run is done and the task
      // took the terminal's status.
      await expect
        .poll(
          async () => {
            const run = await apiGet<FlowRunResponse>(request, `/tasks/${task.id}/flow`);
            return run.status;
          },
          { timeout: 15_000 },
        )
        .toBe("completed");

      await expect(panel).toHaveAttribute("data-flow-status", "completed");
      await expect(page.getByTestId("flow-gate-form")).toHaveCount(0);
      await expect(page.getByTestId("flow-halt-button")).toHaveCount(0);

      const ledgerRow = page.locator('[data-testid="flow-ledger-row"][data-node-id="sign_off"]');
      await expect(ledgerRow).toHaveAttribute("data-node-outcome", "send_back");
      await expect(ledgerRow).toContainText("not ready, sending it back");
      await expect(
        page.locator('[data-testid="flow-ledger-row"][data-node-id="sent_back"]'),
      ).toBeVisible();

      const updated = await apiGet<Task>(request, `/tasks/${task.id}`);
      expect(updated.status).toBe("blocked");
    } finally {
      await apiDelete(request, `/tasks/${task.id}`);
    }
  });

  test("selecting a node shows the edges that leave it", async ({ page, request }) => {
    const task = await createTask(request, tid("pw-flow-select"));
    try {
      await apiPost(request, `/tasks/${task.id}/flow`, {
        definition: gateFlow("pw-gate-select"),
        start: true,
      });
      await openTask(page, task.id);

      await page.locator('[data-testid="flow-graph-node"][data-node-id="sign_off"]').click();
      const detail = page.getByTestId("flow-node-detail");
      await expect(detail).toHaveAttribute("data-node-id", "sign_off");
      await expect(detail.locator('[data-testid="flow-node-detail-edge"]')).toHaveCount(2);
      await expect(detail.locator('[data-testid="flow-node-detail-edge"]').first()).toContainText(
        "outcome ship_it",
      );
    } finally {
      await apiDelete(request, `/tasks/${task.id}`);
    }
  });

  test("halting a run from the panel stops it and reports why", async ({ page, request }) => {
    const task = await createTask(request, tid("pw-flow-halt"));
    try {
      await apiPost(request, `/tasks/${task.id}/flow`, {
        definition: gateFlow("pw-gate-halt"),
        start: true,
      });
      await openTask(page, task.id);

      await page.getByTestId("flow-halt-button").click();
      await page.getByTestId("confirm-dialog-confirm").click();

      await expect
        .poll(
          async () => {
            const run = await apiGet<FlowRunResponse>(request, `/tasks/${task.id}/flow`);
            return run.status;
          },
          { timeout: 15_000 },
        )
        .toBe("cancelled");

      await expect(page.getByTestId("flow-run-panel")).toHaveAttribute(
        "data-flow-status",
        "cancelled",
      );
      await expect(page.getByTestId("flow-halt-reason")).toContainText("web dashboard");
    } finally {
      await apiDelete(request, `/tasks/${task.id}`);
    }
  });

  test("a gate with no derivable outcomes asks for one, and a tripped rail is reported", async ({
    page,
    request,
  }) => {
    const task = await createTask(request, tid("pw-flow-rail"));
    try {
      await apiPost(request, `/tasks/${task.id}/flow`, {
        definition: deadEndFlow("pw-gate-deadend"),
        start: true,
      });
      await openTask(page, task.id);

      // No edge routes on an outcome, so there is no menu to offer.
      await expect(page.getByTestId("flow-gate-outcome")).toHaveCount(0);
      await page.getByTestId("flow-gate-outcome-input").fill("ship_it");
      await page.getByTestId("flow-gate-submit").click();

      // Nothing matched, so the engine halted the run instead of guessing.
      await expect
        .poll(
          async () => {
            const run = await apiGet<FlowRunResponse>(request, `/tasks/${task.id}/flow`);
            return run.status;
          },
          { timeout: 15_000 },
        )
        .toBe("halted");

      const banner = page.getByTestId("flow-halt-reason");
      await expect(banner).toBeVisible();
      await expect(banner).toHaveAttribute("data-halt-reason", /^no_matching_edge/);
      await expect(banner).toContainText("nothing to route to");
      await expect(page.getByTestId("flow-run-panel")).toHaveAttribute(
        "data-flow-status",
        "halted",
      );

      // The flow's halt_task_status hands the task to a human.
      const updated = await apiGet<Task>(request, `/tasks/${task.id}`);
      expect(updated.status).toBe("paused");
    } finally {
      await apiDelete(request, `/tasks/${task.id}`);
    }
  });
});

test.describe("queued tasks on the board", () => {
  test("a queued task sits in Todo and says it is queued", async ({ page, request }) => {
    const task = await createTask(request, tid("pw-queued"));
    try {
      // `queued` is what the flow runner sets while a node waits for a worker
      // slot: pending work, not work in progress.
      await apiPatch<Task>(request, `/tasks/${task.id}`, { status: "queued" });

      await gotoView(page, "tasks");
      const card = page.locator(`[data-testid="kanban-card"][data-task-id="${task.id}"]`);
      await expect(card).toHaveAttribute("data-task-status", "queued");
      await expect(card.getByTestId("kanban-card-status")).toHaveText("queued");

      const todoColumn = page.locator('[data-testid="kanban-column"][data-column-status="todo"]');
      await expect(
        todoColumn.locator(`[data-testid="kanban-card"][data-task-id="${task.id}"]`),
      ).toBeVisible();
      await expect(
        page
          .locator('[data-testid="kanban-column"][data-column-status="doing"]')
          .locator(`[data-task-id="${task.id}"]`),
      ).toHaveCount(0);
    } finally {
      await apiDelete(request, `/tasks/${task.id}`);
    }
  });

  test("the dashboard counts a queued task as pending, not in progress", async ({
    page,
    request,
  }) => {
    const task = await createTask(request, tid("pw-queued-dash"));
    try {
      const { tasks } = await apiGet<{ tasks: Task[] }>(request, "/tasks?limit=100");
      const doing = tasks.filter((t) => t.status === "doing").length;
      const pending = tasks.filter((t) => t.status === "todo" || t.status === "queued").length;

      await apiPatch<Task>(request, `/tasks/${task.id}`, { status: "queued" });
      await gotoView(page, "dashboard");

      // Moving todo → queued must not move the Doing tile, and must leave the
      // Todo tile where it was: both surfaces treat queued as pending.
      const value = (label: string) =>
        page
          .locator(`[data-testid="stat-card"][data-stat-label="${label}"]`)
          .getByTestId("stat-card-value");
      await expect(value("Doing")).toHaveText(String(doing));
      await expect(value("Todo")).toHaveText(String(pending));
    } finally {
      await apiDelete(request, `/tasks/${task.id}`);
    }
  });
});
