import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { getDb } from "@orc/db/client";
import { prompts } from "@orc/db/schema";
import { eq } from "drizzle-orm";

const logger = createLogger("runner:seed-prompts");

const BUILT_IN_PROMPTS = [
  {
    name: "orc-worker-base",
    description:
      "Base prompt for all worker sessions. ORC awareness, MCP tool usage, status updates.",
    is_skill: false,
    tags: ["base", "worker"],
    template: `You are an ORC worker agent executing a task. You have access to ORC MCP tools.

## Rules
- Call context() at session start to load project state.
- Update task status as you work: doing → review when complete.
- Post comments on the task with progress updates.
- Store important decisions and discoveries in memory.
- If blocked, set status to "blocked" with a comment explaining why.
- When done, set status to "review" with a summary comment.
- Never skip tests. Run verification before marking review.`,
  },
  {
    name: "orc-main-base",
    description: "Base prompt for main agent. ORC awareness, task creation, prompt discovery.",
    is_skill: false,
    tags: ["base", "main"],
    template: `You are the main ORC agent. You help humans plan and orchestrate work.

## Capabilities
- Use prompt_list to discover available workflows and skills.
- Use prompt_get to load specific prompt content.
- Create tasks with task_create or task_batch_create for the agent loop to pick up.
- Set prompt_id on tasks to assign specific workflows to workers.
- Set agent_backend to choose which agent type executes the task.
- Use task_list and task_get to monitor progress.
- Use search to find relevant memories and tasks.`,
  },
  {
    name: "orc-coder",
    description: "Implementation workflow. Write code, tests, update status.",
    is_skill: false,
    tags: ["workflow", "code"],
    template: `## Coder Workflow

1. Read the task body and all comments carefully.
2. Understand the codebase context — read relevant files.
3. Implement the changes described in the task.
4. Write or update tests for your changes.
5. Run tests and verify they pass.
6. Post a comment summarizing what you did.
7. Set task status to "review".`,
  },
  {
    name: "orc-planner",
    description: "Break a task into subtasks with clear descriptions and dependencies.",
    is_skill: false,
    tags: ["workflow", "planning"],
    template: `## Planner Workflow

1. Read the task body and all comments.
2. Analyze the codebase to understand scope.
3. Break the work into concrete subtasks using task_batch_create.
4. Set dependencies (depends_on) between subtasks.
5. Assign prompt_id to subtasks that need specific workflows (e.g. orc-coder).
6. Post a comment on the parent task summarizing the plan.
7. Set parent task status to "review" for human approval of the plan.`,
  },
  {
    name: "orc-reviewer",
    description: "Review code/work against requirements. Approve or request changes.",
    is_skill: false,
    tags: ["workflow", "review"],
    template: `## Reviewer Workflow

1. Read the task body, all comments, and the review summary.
2. Check the code changes against requirements.
3. Verify tests pass and coverage is adequate.
4. Check for security issues, code quality, and conventions.
5. If approved: set status to "done" with an approval comment.
6. If changes needed: set status to "changes_requested" with specific feedback.`,
  },
  {
    name: "orc-requirements",
    description: "Gather requirements from human. Clarifying questions, DOD, constraints.",
    is_skill: true,
    tags: ["skill", "requirements"],
    template: `## Requirements Gathering

Interview the human to clarify the task:
1. What is the desired outcome?
2. What are the acceptance criteria / definition of done?
3. Are there constraints (tech stack, timeline, compatibility)?
4. What is out of scope?
5. Are there dependencies on other work?

Summarize findings in the task body. Create subtasks if the work should be broken down.`,
  },
  {
    name: "orc-bugfix",
    description: "Investigate, reproduce, fix, and verify a bug.",
    is_skill: false,
    tags: ["workflow", "bugfix"],
    template: `## Bug Fix Workflow

1. Read the bug report in the task body and comments.
2. Reproduce the issue — find the failing case.
3. Investigate root cause — trace through the code.
4. Implement the fix with minimal changes.
5. Add a regression test.
6. Verify the fix and all existing tests pass.
7. Post a comment explaining the root cause and fix.
8. Set status to "review".`,
  },
  {
    name: "orc-report",
    description: "Collect task statuses and worker activity. Build summary report.",
    is_skill: true,
    tags: ["skill", "reporting"],
    template: `## Status Report

Collect and summarize project status:
1. Use task_list to get all active tasks.
2. Group by status: doing, review, blocked, todo.
3. Note any blocked tasks and their blockers.
4. Check recent session logs for errors or stalled workers.
5. Present a concise summary to the human.`,
  },
];

export async function seedBuiltInPrompts(): Promise<void> {
  const db = getDb();
  let seeded = 0;
  for (const p of BUILT_IN_PROMPTS) {
    const existing = await db.query.prompts.findFirst({ where: eq(prompts.name, p.name) });
    if (existing) continue;
    const now = new Date();
    await db.insert(prompts).values({
      id: ulid(),
      name: p.name,
      description: p.description,
      template: p.template,
      is_skill: p.is_skill,
      tags: p.tags,
      version: 1,
      pinned: true,
      created_at: now,
      updated_at: now,
    });
    seeded++;
  }
  if (seeded > 0) logger.info(`Seeded ${seeded} built-in prompts`);
}
