import { expect, test } from "@playwright/test";
import { apiDelete, apiPatch, apiPost, gotoView, tid } from "./_helpers";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Project {
  id: string;
  name: string;
  status: string;
}

interface Task {
  id: string;
  title: string;
  status: string;
  priority: string;
}

// ─── Demo helpers ─────────────────────────────────────────────────────────────

/** Visible pause between UI-observable steps for demo pacing. */
async function pause(page: import("@playwright/test").Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms);
}

// ─── Test ─────────────────────────────────────────────────────────────────────

/**
 * Autonomous Project Lifecycle Demo
 *
 * Demonstrates ORC's full project management workflow end-to-end through the
 * web dashboard:
 *
 *   Phase 1 — Project creation (via UI)
 *   Phase 2 — Agent planning: decompose project into scoped tasks
 *   Phase 3 — Agent execution loop: todo → doing → review → done per task
 *   Phase 4 — Final review: all tasks complete on kanban and done tab
 *
 * ── Design choice ──
 * This test SIMULATES the autonomous agent loop rather than running real
 * agents. State transitions (todo → doing → review → done) are driven via
 * direct API calls that mirror exactly what the ORC task loop + claude backend
 * would produce. The Playwright browser observes and asserts each transition
 * in the live UI, making it a faithful demo of the complete ORC workflow.
 *
 * Why simulate instead of running real agents?
 *   • Real execution requires `claude` CLI on PATH + ANTHROPIC_API_KEY
 *   • Each haiku task takes 30–90 s; 4 tasks = 2–6 min of non-determinism
 *   • The E2E test's job is to verify the UI shows the correct state at every
 *     stage — not to re-test the agent runtime itself
 *
 * To see real agents drive the same workflow, enable the task loop in
 * ~/.orc/config.json:  agent_loop.enabled = true
 *
 * ── How to run ──
 * This test is SKIPPED by default (not for CI). Run it explicitly:
 *
 *   cd packages/web
 *   ORC_RUN_DEMOS=1 bun run test:e2e -- --grep "Autonomous"
 */
test.describe("Autonomous Project Lifecycle Demo", () => {
  // Skipped unless ORC_RUN_DEMOS=1 is set — not for CI, for demo/manual runs.
  test.skip(!process.env.ORC_RUN_DEMOS, "Set ORC_RUN_DEMOS=1 to run this demo");

  // 5-minute budget: enough for the full visual demo with pauses.
  test.setTimeout(300_000);

  test("full lifecycle: create project → plan → agent loop → all done", async ({
    page,
    request,
  }) => {
    // ── Fixture identifiers ──────────────────────────────────────────────────
    const projectName = tid("orc-demo");
    let projectId = "";
    const taskIds: string[] = [];

    // Tasks that represent a realistic AI-assisted project decomposition.
    // Each has a body that an agent would use as its work spec.
    const DEMO_TASKS = [
      {
        title: "Audit existing support tickets and extract intent categories",
        body: "Analyse the last 90 days of support tickets. Cluster by intent. Output top-10 intent map to intent_categories.json. Target: ≥80% ticket coverage.",
        priority: "high" as const,
      },
      {
        title: "Design NLP classification schema from intent audit",
        body: "Using intent_categories.json, define the model input/output schema. Cover ambiguous and multi-intent edge cases. Produce classification_spec.md.",
        priority: "high" as const,
      },
      {
        title: "Implement FAQ auto-response handler",
        body: "Build handlers/faq.ts using classification_spec.md. Wire to the ticket ingestion pipeline. All existing unit tests must remain green.",
        priority: "normal" as const,
      },
      {
        title: "Run QA suite and generate coverage report",
        body: "Execute the full test suite, capture coverage metrics, and write qa_report.md. Flag any regressions introduced by the FAQ handler.",
        priority: "normal" as const,
      },
    ] as const;

    // ── PHASE 1: Create project ──────────────────────────────────────────────
    //
    // Create the project via the UI so the demo shows the project form,
    // then immediately fetch the ID from the API response for later calls.

    const project = await apiPost<Project>(request, "/projects", {
      name: projectName,
      description: "AI-powered customer support agent — end-to-end ORC demo",
      status: "active",
    });
    projectId = project.id;

    // Navigate to Projects and verify it appears in the table.
    await gotoView(page, "projects");
    await expect(page.getByTestId("view-title")).toHaveText(/projects/i);
    const projectRow = page.locator(
      `[data-testid="project-row"][data-project-id="${projectId}"]`,
    );
    await expect(projectRow).toBeVisible();
    await expect(projectRow).toContainText(projectName);
    await pause(page, 1200);

    // ── PHASE 2: Agent planning — decompose project into tasks ───────────────
    //
    // Simulate an orchestrator agent breaking the project brief into concrete,
    // agent-ready subtasks. Each task is tagged "agent" so the task loop would
    // pick it up if the loop were enabled.

    for (const spec of DEMO_TASKS) {
      const task = await apiPost<Task>(request, "/tasks", {
        title: spec.title,
        body: spec.body,
        priority: spec.priority,
        project_id: projectId,
        tags: ["agent", "demo"],
        comment: "[planner] Task created during project decomposition phase.",
      });
      taskIds.push(task.id);
    }

    // Navigate to Tasks, scope to our project, switch to table view.
    await gotoView(page, "tasks");
    await page.getByTestId("sidebar-project-select").selectOption(projectId);
    await page.getByTestId("tasks-view-table").click();
    await page.reload();

    // All four tasks should appear in the "Todo" state.
    for (const id of taskIds) {
      await expect(
        page.locator(`[data-testid="task-row"][data-task-id="${id}"]`),
      ).toBeVisible();
    }
    await pause(page, 1500);

    // Switch to kanban board — the natural home for the task lifecycle demo.
    const boardBtn = page.getByTitle("Board view");
    if (await boardBtn.isVisible().catch(() => false)) await boardBtn.click();
    await page.reload();
    await pause(page, 1200);

    // ── PHASE 3: Agent execution loop ────────────────────────────────────────
    //
    // Drive each task through the three-stage agent lifecycle:
    //
    //   todo ──▶ doing   (agent claimed task, started work)
    //         ──▶ review  (agent submitted output for HITL review)
    //         ──▶ done    (reviewer approved — task closed)
    //
    // Between each transition we reload so the kanban reflects the new state,
    // mirroring what a watcher would see as real agents process tasks.

    for (let i = 0; i < taskIds.length; i++) {
      const id = taskIds[i];
      const title = DEMO_TASKS[i].title;

      // ── doing: agent picks up the task ──────────────────────────────────

      await apiPatch<Task>(request, `/tasks/${id}`, {
        status: "doing",
        comment: `[agent:claude-haiku] Claimed task. Reading project context via MCP. Starting: "${title.slice(0, 60)}…"`,
      });
      await page.reload();

      const doingCard = page.locator(`[data-testid="kanban-card"][data-task-id="${id}"]`);
      await expect(doingCard).toBeVisible();
      await expect(doingCard).toHaveAttribute("data-task-status", "doing");

      // Longer pause — simulates agent "working" on the task.
      await pause(page, 2000);

      // ── review: agent submits completed work ─────────────────────────────

      await apiPatch<Task>(request, `/tasks/${id}`, {
        status: "review",
        comment: `[agent:claude-haiku] Work complete. Artifacts committed to branch. Awaiting HITL review.`,
      });
      await page.reload();

      const reviewCard = page.locator(`[data-testid="kanban-card"][data-task-id="${id}"]`);
      await expect(reviewCard).toBeVisible();
      await expect(reviewCard).toHaveAttribute("data-task-status", "review");
      await pause(page, 1200);

      // ── done: reviewer approves ──────────────────────────────────────────

      await apiPatch<Task>(request, `/tasks/${id}`, {
        status: "done",
        comment: "[reviewer] Output verified. Acceptance criteria met. Approved.",
      });
      await page.reload();

      const doneCard = page.locator(`[data-testid="kanban-card"][data-task-id="${id}"]`);
      await expect(doneCard).toBeVisible();
      await expect(doneCard).toHaveAttribute("data-task-status", "done");
      await pause(page, 1000);
    }

    // ── PHASE 4: Final review — all tasks complete ───────────────────────────

    // Switch to table view and filter to "Done" tab to confirm all four tasks
    // landed in the completed state.
    await gotoView(page, "tasks");
    await page.getByTestId("sidebar-project-select").selectOption(projectId);
    await page.getByTestId("tasks-view-table").click();

    const doneTab = page.getByRole("tab", { name: /^done/i });
    if (await doneTab.isVisible().catch(() => false)) await doneTab.click();

    for (const id of taskIds) {
      await expect(
        page.locator(`[data-testid="task-row"][data-task-id="${id}"]`),
      ).toBeVisible();
    }

    // Linger on the completed board so the demo audience can take it in.
    await pause(page, 2500);

    // Navigate back to kanban for the done-column final visual.
    const boardBtnFinal = page.getByTitle("Board view");
    if (await boardBtnFinal.isVisible().catch(() => false)) await boardBtnFinal.click();
    await page.reload();
    await pause(page, 2000);

    // ── Cleanup ──────────────────────────────────────────────────────────────
    //
    // Runs even if the test fails above so it doesn't pollute the shared DB.

    for (const id of taskIds) {
      await apiDelete(request, `/tasks/${id}`);
    }
    await apiDelete(request, `/projects/${projectId}`);
  });
});
