// ─── WIP ──────────────────────────────────────────────────────────────────────
//
// STATUS: NOT YET WORKING — workers complete but tasks stay in "doing".
//
// Root cause (suspected): the scope-dir .mcp.json routing is set up correctly
// but worker agents aren't successfully calling task_update via MCP to set
// status="review". Needs further debugging:
//   - Verify startScheduler() is needed alongside startTaskLoop() in test-daemon
//   - Confirm Claude CLI actually picks up .mcp.json from the project scope dir
//   - Add verbose logging to workers to see MCP call failures
//
// This test is safe to leave here — it skips unless ORC_RUN_DEMOS=1 AND the
// agent loop job exists in the DB. Run with:
//   bun run test:e2e:real-agent
//
// ─────────────────────────────────────────────────────────────────────────────

import { expect, type Page, test } from "@playwright/test";
import { API_BASE, apiDelete, apiGet, apiPost, AUTH_HEADERS, gotoView, tid } from "./_helpers";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Project {
  id: string;
  name: string;
}

interface Task {
  id: string;
  title: string;
  status: string;
}

interface JobList {
  jobs: { name: string; id: string }[];
}

// ─── Timings ─────────────────────────────────────────────────────────────────

/** How long to wait for the loop to claim a task (queued/doing). */
const CLAIM_TIMEOUT_MS = 90_000;

/** How long to wait for the worker agent to submit the task for review. */
const WORKER_TIMEOUT_MS = 5 * 60_000;

/** How long to wait for the reviewer agent to approve (done). */
const REVIEWER_TIMEOUT_MS = 4 * 60_000;

/** Poll frequency while waiting for status changes. */
const POLL_INTERVAL_MS = 4_000;

/** Brief pause between UI steps so the audience can follow. */
async function look(page: Page, ms = 1200): Promise<void> {
  await page.waitForTimeout(ms);
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

/**
 * Text-only tasks: no code, no tests to run.
 * The agent writes its answer as a task comment and submits for review.
 * Haiku completes each of these in ≈ 30–90 seconds.
 */
const DEMO_TASKS = [
  {
    title: "Write a value proposition for ORC",
    body: [
      "Write a 2-sentence value proposition for ORC (the ORC orchestration hub).",
      "Cover: (1) the core problem ORC solves, (2) the unique benefit over alternatives.",
      "",
      "This is a text-only task — no code changes, no tests.",
      "Post your answer as a comment on this task, then submit for review.",
    ].join("\n"),
    priority: "high" as const,
  },
  {
    title: "Identify the top 3 ORC user personas",
    body: [
      "List the top 3 user personas for ORC as concise bullet points.",
      "Each bullet: role title + one-sentence pain point that ORC addresses.",
      "",
      "This is a text-only task — no code changes, no tests.",
      "Post your answer as a comment on this task, then submit for review.",
    ].join("\n"),
    priority: "normal" as const,
  },
  {
    title: "Draft 3 ORC differentiator statements",
    body: [
      "Write 3 one-sentence statements that describe ORC's most distinctive features",
      "compared to generic task managers or CI/CD pipelines.",
      "",
      "This is a text-only task — no code changes, no tests.",
      "Post your answer as a comment on this task, then submit for review.",
    ].join("\n"),
    priority: "normal" as const,
  },
] as const;

// ─── Test ─────────────────────────────────────────────────────────────────────

/**
 * Real Agent Lifecycle Demo
 *
 * This test drives real ORC agents through the full project management
 * lifecycle — no mocks, no API shortcircuits. The actual task loop picks up
 * each task, a claude worker agent completes it, and a claude reviewer agent
 * approves it. The Playwright browser observes every state transition live.
 *
 * Flow
 * ────
 *   1. Create project + 3 text-only tasks (agent_backend: "claude")
 *   2. Task loop auto-triggers on task creation (triggerTaskCheck)
 *   3. For each task:
 *        todo → queued/doing  (loop claims task, worker session starts)
 *        doing → review       (worker posts answer, submits for review)
 *        review → done        (reviewer approves)
 *   4. Final kanban: all 3 tasks in the "done" column
 *
 * Requirements
 * ────────────
 *   ~/.orc/config.json:
 *     agent_loop.enabled   = true
 *     agent_loop.max_workers ≥ 1
 *   claude CLI on PATH with ANTHROPIC_API_KEY set
 *
 * The test self-skips if the agent loop system job is not present (loop
 * was never started for this ORC instance).
 *
 * Run explicitly
 * ──────────────
 *   cd packages/web
 *   bun run test:e2e -- --grep "Real Agent"
 */
test.describe("Real Agent Lifecycle Demo", () => {
  // Skipped unless ORC_RUN_DEMOS=1 — requires agent loop enabled + claude CLI.
  test.skip(!process.env.ORC_RUN_DEMOS, "Set ORC_RUN_DEMOS=1 to run this demo");

  // Generous budget: 3 tasks × (worker + reviewer) at haiku speed ≈ 8–12 min.
  test.setTimeout(20 * 60_000);

  test(
    "full lifecycle: create → agent loop → worker → reviewer → done",
    async ({ page, request }) => {
      const projectName = tid("real-demo");
      let projectId = "";
      const taskIds: string[] = [];

      // ── Preflight: verify agent loop is running ──────────────────────────
      //
      // The system job "orc-task-loop" is created when startTaskLoop() runs.
      // If it doesn't exist, the loop has never been started for this instance
      // and real agents cannot be dispatched.

      const { jobs } = await apiGet<JobList>(request, "/jobs?limit=100");
      const loopJob = jobs.find((j) => j.name === "orc-task-loop");

      if (!loopJob) {
        // Self-skip with a clear diagnostic — do not fail.
        test.skip(
          true,
          "Agent loop not running — set agent_loop.enabled=true in ~/.orc/config.json and restart the API",
        );
        return;
      }

      try {
        // ── 1. Create project ──────────────────────────────────────────────
        //
        // Set scope to ORC_DEMO_SCOPE_DIR (injected by run-real-agent-demo.ts).
        // That directory contains a .mcp.json pointing at the test daemon port,
        // so worker agents resolve the ORC MCP server correctly regardless of
        // what port the live system uses.

        const scopeDir = process.env.ORC_DEMO_SCOPE_DIR;

        const project = await apiPost<Project>(request, "/projects", {
          name: projectName,
          description: "ORC product positioning — real-agent demo project",
          status: "active",
          ...(scopeDir ? { scope: scopeDir } : {}),
        });
        projectId = project.id;

        await gotoView(page, "projects");
        await expect(
          page.locator(`[data-testid="project-row"][data-project-id="${projectId}"]`),
        ).toBeVisible();
        await look(page, 1000);

        // ── 2. Create tasks — agent_backend: "claude" makes them loop-eligible

        for (const spec of DEMO_TASKS) {
          const task = await apiPost<Task>(request, "/tasks", {
            title: spec.title,
            body: spec.body,
            priority: spec.priority,
            project_id: projectId,
            agent_backend: "claude",
            tags: ["demo"],
            // The API calls triggerTaskCheck() after each create, so the loop
            // is notified immediately — no manual trigger needed.
          });
          taskIds.push(task.id);
        }

        // Navigate to kanban, scope to our project so only demo tasks show.
        await gotoView(page, "tasks");
        await page.getByTestId("sidebar-project-select").selectOption(projectId);
        const boardBtn = page.getByTitle("Board view");
        if (await boardBtn.isVisible().catch(() => false)) await boardBtn.click();
        await page.reload();
        await look(page, 1500);

        // All tasks start in "todo".
        for (const id of taskIds) {
          const card = page.locator(`[data-testid="kanban-card"][data-task-id="${id}"]`);
          await expect(card).toBeVisible();
        }

        // ── 3. Agent execution loop ────────────────────────────────────────
        //
        // With max_workers=1 (default), tasks run one at a time. We poll each
        // task through the full lifecycle before checking the next, which
        // matches the sequential dispatch order of the task loop.

        for (let i = 0; i < taskIds.length; i++) {
          const id = taskIds[i];

          // ── 3a. Wait for worker to claim task (todo → queued/doing) ───────

          await expect
            .poll(
              async () => {
                const res = await request.get(`${API_BASE}/tasks/${id}`, {
                  headers: AUTH_HEADERS,
                });
                return ((await res.json()) as Task).status;
              },
              {
                message: `Task ${i + 1} was not claimed within ${CLAIM_TIMEOUT_MS / 1000}s — is the agent loop running?`,
                timeout: CLAIM_TIMEOUT_MS,
                intervals: [POLL_INTERVAL_MS],
              },
            )
            .toMatch(/^(queued|doing)$/);

          await page.reload();
          await look(page, 1200);

          // ── 3b. Wait for worker to submit for review (doing → review) ─────

          await expect
            .poll(
              async () => {
                const res = await request.get(`${API_BASE}/tasks/${id}`, {
                  headers: AUTH_HEADERS,
                });
                return ((await res.json()) as Task).status;
              },
              {
                message: `Worker did not submit task ${i + 1} for review within ${WORKER_TIMEOUT_MS / 1000}s`,
                timeout: WORKER_TIMEOUT_MS,
                intervals: [POLL_INTERVAL_MS],
              },
            )
            .toBe("review");

          await page.reload();
          const reviewCard = page.locator(
            `[data-testid="kanban-card"][data-task-id="${id}"]`,
          );
          await expect(reviewCard).toHaveAttribute("data-task-status", "review");
          await look(page, 1500);

          // ── 3c. Wait for reviewer to approve (review → done) ──────────────

          await expect
            .poll(
              async () => {
                const res = await request.get(`${API_BASE}/tasks/${id}`, {
                  headers: AUTH_HEADERS,
                });
                return ((await res.json()) as Task).status;
              },
              {
                message: `Reviewer did not approve task ${i + 1} within ${REVIEWER_TIMEOUT_MS / 1000}s`,
                timeout: REVIEWER_TIMEOUT_MS,
                intervals: [POLL_INTERVAL_MS],
              },
            )
            .toBe("done");

          await page.reload();
          const doneCard = page.locator(
            `[data-testid="kanban-card"][data-task-id="${id}"]`,
          );
          await expect(doneCard).toHaveAttribute("data-task-status", "done");
          await look(page, 1000);
        }

        // ── 4. Final view: all 3 tasks in the done column ─────────────────

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

        await look(page, 2500);

        // Sessions view: show the agent sessions that ran for this project.
        await gotoView(page, "sessions");
        await look(page, 2000);
      } finally {
        // ── Cleanup ───────────────────────────────────────────────────────
        //
        // Always runs, even on failure. Deletes tasks before the project so
        // foreign-key constraints are satisfied.

        for (const id of taskIds) {
          await request
            .delete(`${API_BASE}/tasks/${id}`, { headers: AUTH_HEADERS })
            .catch(() => {});
        }
        if (projectId) {
          await request
            .delete(`${API_BASE}/projects/${projectId}`, { headers: AUTH_HEADERS })
            .catch(() => {});
        }
      }
    },
  );
});
