import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { apiDelete, apiGet, apiPost, gotoView, tid } from "./_helpers";

type GoalRun = {
  status: "active" | "passed" | "halted" | "stopped";
  iteration: number;
  tokens_used: number;
  last_check: { exit: number | null } | null;
};
type GoalBody = {
  goal: { id: string; task_id: string; run: GoalRun | null };
  history: { outcome: string | null }[];
};

/**
 * The goal loop end-to-end with the deterministic e2e fixture worker
 * (ORC_E2E_GOAL_FIXTURE=1, registered by the shard API): turn one makes no
 * artifact, turn two writes it, so the external check fails once and passes on
 * iteration two. Proves the loop, the resume, the check history and the task
 * panel without a paid agent.
 */
test("@sanity a goal loops worker and check until the check passes", async ({ page, request }) => {
  test.setTimeout(120_000);
  const scope = mkdtempSync(join(tmpdir(), "orc-goal-e2e-"));
  writeFileSync(
    join(scope, "check.mjs"),
    "import fs from 'node:fs'; process.exit(fs.existsSync('goal-marker') ? 0 : 1);",
  );
  let projectId = "";
  let taskId = "";
  try {
    const project = await apiPost<{ id: string }>(request, "/projects", {
      name: tid("goal-e2e"),
      scope,
    });
    projectId = project.id;

    const { goal } = await apiPost<GoalBody>(request, "/goals", {
      objective: "make the marker exist",
      check: "bun check.mjs",
      agents: ["goal-fixture"],
      project_id: projectId,
      budget: { iterations: 5, hours: 1 },
    });
    taskId = goal.task_id;

    await expect
      .poll(
        async () => {
          const body = await apiGet<GoalBody>(request, `/goals/${goal.id}`);
          return body.goal.run?.status ?? "none";
        },
        { timeout: 90_000, intervals: [1_000], message: "goal did not reach a verdict" },
      )
      .toBe("passed");

    const body = await apiGet<GoalBody>(request, `/goals/${goal.id}`);
    expect(body.goal.run?.iteration).toBe(2);
    // Two fixture turns at 15 tokens each, accumulated from result usage.
    expect(body.goal.run?.tokens_used).toBe(30);
    expect(body.history.map((visit) => visit.outcome)).toEqual(["failed", "passed"]);
    const task = await apiGet<{ status: string }>(request, `/tasks/${taskId}`);
    expect(task.status).toBe("done");

    // The task shows the goal's loop state, not just the flow graph.
    await gotoView(page, "tasks");
    await page.goto(`/tasks/${taskId}`);
    const sheet = page.getByTestId("task-detail-sheet");
    await expect(sheet).toBeVisible();
    const panel = sheet.getByTestId("goal-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-goal-status", "passed");
    await expect(panel.getByTestId("goal-iteration")).toContainText("2 / 5");
    await expect(panel.getByTestId("goal-agent")).toContainText("goal-fixture");
    await expect(panel.getByTestId("goal-last-check")).toContainText("exit 0");
    await expect(panel.getByTestId("goal-stop-button")).toHaveCount(0);

    await panel.getByTestId("goal-history-toggle").click();
    const history = panel.getByTestId("goal-history");
    await expect(history).toBeVisible();
    await expect(history).toContainText("failed");
    await expect(history).toContainText("passed");
  } finally {
    if (taskId) await apiDelete(request, `/tasks/${taskId}`).catch(() => {});
    if (projectId) await apiDelete(request, `/projects/${projectId}`).catch(() => {});
    rmSync(scope, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  }
});
