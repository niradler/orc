import { expect, type Request, test } from "@playwright/test";
import { openFinalFormStep, revealFormField } from "./_form-ui";
import { apiGet, apiPost, gotoView, tid } from "./_helpers";

test("fresh project hands off to workflow task and reopens persisted choices", async ({
  page,
  request,
}) => {
  const name = tid("onboarding");
  const title = tid("first-task");
  await gotoView(page, "projects");
  await page.getByTestId("new-project-button").click();
  await revealFormField(page, page.getByTestId("project-name-input"));
  await page.getByTestId("project-name-input").fill(name);
  await revealFormField(page, page.getByTestId("project-folder-input"));
  await page.getByTestId("project-folder-input").fill("/fixture/project");
  await openFinalFormStep(page);
  await page.getByTestId("project-submit").click();
  await expect(page.getByTestId("task-onboarding-hint")).toHaveCount(0);
  await page.getByRole("button", { name: "About task creation", exact: true }).click();
  await expect(page.getByTestId("task-onboarding-hint")).toBeVisible();
  await expect(page.getByTestId("task-onboarding-hint")).toHaveText(
    "Choose a project folder, describe the result and acceptance checks, then preview a workflow. Built-in workflows include implementation and review skills automatically.",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("new-task-project")).toContainText(name);
  await revealFormField(page, page.getByTestId("task-title-input"));
  await page.getByTestId("task-title-input").fill(title);
  await revealFormField(page, page.getByTestId("task-body-input"));
  await page.getByTestId("task-body-input").fill("Acceptance: verify expected artifact behavior.");
  const helpRequests: string[] = [];
  const observeRequest = (req: Request) => {
    if (["POST", "PATCH", "DELETE"].includes(req.method())) helpRequests.push(req.url());
  };
  page.on("request", observeRequest);
  await page.getByRole("button", { name: "About task creation", exact: true }).click();
  await expect(page.getByTestId("task-onboarding-hint")).toBeVisible();
  await page.keyboard.press("Escape");
  expect(helpRequests).toEqual([]);
  page.off("request", observeRequest);
  await expect(page.getByTestId("task-title-input")).toHaveValue(title);
  await expect(page.getByTestId("task-body-input")).toHaveValue(
    "Acceptance: verify expected artifact behavior.",
  );
  await revealFormField(page, page.getByTestId("new-task-flow"));
  await page.getByTestId("new-task-flow").click();
  await page.getByTestId("flow-option-orc-human-review").click();
  await page.getByTestId("flow-picker-view").click();
  await expect(page.getByTestId("flow-detail")).toBeVisible();
  await page.keyboard.press("Escape");
  await openFinalFormStep(page);
  await page.getByTestId("task-submit").click();
  const tasks = await apiGet<{
    tasks: Array<{
      id: string;
      title: string;
      project_id: string;
      flow_name: string;
      skill_name: string | null;
    }>;
  }>(request, "/tasks?limit=100");
  const task = tasks.tasks.find((item) => item.title === title);
  expect(task?.flow_name).toBe("orc-human-review");
  expect(task?.skill_name).toBeNull();
  expect(task?.project_id).toBeTruthy();
  await page.goto(`/tasks/${task?.id}`);
  await expect(page.getByTestId("task-detail-sheet")).toContainText(title);
  await page.reload();
  await expect(page.getByTestId("task-flow-name")).toContainText("orc-human-review");
});

test("missing project folder blocks launch but permits saving", async ({ page }) => {
  await gotoView(page, "tasks");
  await page.getByTestId("new-task-button").click();
  await revealFormField(page, page.getByTestId("task-title-input"));
  await page.getByTestId("task-title-input").fill(tid("unassigned"));
  await openFinalFormStep(page);
  await expect(page.getByTestId("task-create-start")).toBeDisabled();
  await expect(page.getByTestId("task-submit")).toBeEnabled();
  await expect(page.getByTestId("task-start-readiness")).toContainText("select a project");
});

test("create and start retries the saved task and persists human approval", async ({
  page,
  request,
}) => {
  const name = tid("onboard-launch");
  const flow = tid("onboard-gate");
  const title = tid("launch-task");
  await apiPost(request, "/flows", {
    definition: {
      name: flow,
      entry: "signoff",
      nodes: {
        signoff: { kind: "human", task_status: "review", outcomes: ["approved"] },
        done: { kind: "terminal", task_status: "done" },
      },
      edges: [{ from: "signoff", to: "done", when: { outcome: "approved" } }],
    },
  });
  await page.route("**/api/backends", (route) =>
    route.fulfill({
      json: {
        default_backend: "claude",
        backends: [
          {
            name: "claude",
            available: true,
            requires: "fixture probe",
            kind: "in-process",
            error: null,
            target: null,
            source: null,
            version: null,
          },
        ],
      },
    }),
  );
  let launchAttempts = 0;
  await page.route("**/api/tasks/*/flow", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    launchAttempts++;
    if (launchAttempts === 1)
      return route.fulfill({ status: 503, json: { error: "Temporary launch failure" } });
    return route.continue();
  });
  await gotoView(page, "projects");
  await page.getByTestId("new-project-button").click();
  await revealFormField(page, page.getByTestId("project-name-input"));
  await page.getByTestId("project-name-input").fill(name);
  await revealFormField(page, page.getByTestId("project-folder-input"));
  await page.getByTestId("project-folder-input").fill("/fixture/project");
  await openFinalFormStep(page);
  await page.getByTestId("project-submit").click();
  await revealFormField(page, page.getByTestId("task-title-input"));
  await page.getByTestId("task-title-input").fill(title);
  await revealFormField(page, page.getByTestId("new-task-flow"));
  await page.getByTestId("new-task-flow").click();
  await page.getByTestId(`flow-option-${flow}`).click();
  await openFinalFormStep(page);
  await page.getByTestId("task-create-start").click();
  await expect(page.getByTestId("task-create-error")).toBeVisible();
  await expect(page.getByTestId("task-title-input")).toBeDisabled();
  await openFinalFormStep(page);
  await page.getByTestId("task-create-start").click();
  await expect(page.getByTestId("flow-gate-form")).toBeVisible();
  const list = await apiGet<{ tasks: Array<{ id: string; title: string; status: string }> }>(
    request,
    "/tasks?limit=100",
  );
  const matching = list.tasks.filter((item) => item.title === title);
  expect(matching).toHaveLength(1);
  expect(matching[0]?.status).toBe("review");
  await page.getByTestId("flow-gate-submit").click();
  await expect(page.getByTestId("flow-run-panel")).toHaveAttribute("data-flow-status", "completed");
  await page.goto(`/tasks/${matching[0]?.id}`);
  await page.reload();
  await expect(page.getByTestId("flow-run-panel")).toHaveAttribute("data-flow-status", "completed");
});
