import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HumanRequest } from "@orc/core/human-requests";
import { expect, test } from "@playwright/test";
import { API_BASE, AUTH_HEADERS, apiGet, apiPost, gotoView, repoRoot, tid } from "./_helpers";

test("should show dated unavailable questions and contextual help on desktop and phone", async ({
  page,
  request,
}) => {
  const origin = tid("stale-question");
  const entry = await apiPost<HumanRequest>(request, "/human-requests", {
    kind: "question",
    prompt: "Cancelled?",
    origin: { backend: "claude", session_id: origin, request_id: "cancelled-question" },
  });
  // Use the same isolated E2E database to reproduce a disconnected origin.
  const seed = spawn(
    "bun",
    [
      "-e",
      `import { getSqlite } from './packages/db/src/client.ts'; import { HumanRequestStore } from './packages/db/src/human-requests.ts'; new HumanRequestStore(getSqlite()).unavailable(${JSON.stringify(entry.id)}, 1);`,
    ],
    {
      cwd: repoRoot(),
      env: process.env,
      stdio: "pipe",
      timeout: 10000,
    },
  );
  expect(
    await new Promise((resolve, reject) => {
      seed.once("exit", resolve);
      seed.once("error", reject);
    }),
  ).toBe(0);
  await gotoView(page, "attention");
  const card = page.getByTestId(`attention-request-${entry.id}`);
  for (const [width, theme] of [
    [1440, "dark"],
    [390, "light"],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((value) => {
      document.documentElement.classList.toggle("dark", value === "dark");
    }, theme);
    await expect(card).toContainText("Cancelled?");
    await expect(card).toContainText("Agent unavailable");
    await expect(card.getByTestId("attention-date")).toContainText("Created");
    await expect(card.locator("time")).toHaveAttribute(
      "datetime",
      new Date(entry.created_at).toISOString(),
    );
    await expect(page.getByTestId("view-title")).toHaveText("Attention needed");
    await page.getByTestId("view-help").click();
    await expect(page.getByTestId("view-help-content")).toContainText(
      "Live Codex questions can also appear as session notices.",
    );
    await page.screenshot({
      path: `../../.claude/docs/attention-${width}-${theme}.png`,
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  const hook = spawn("bun", ["packages/cli/src/index.ts", "rules", "hook", "claude", "Stop"], {
    cwd: repoRoot(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10000,
  });
  hook.stdin.end(JSON.stringify({ session_id: origin, cwd: repoRoot() }));
  expect(
    await new Promise((resolve, reject) => {
      hook.once("exit", resolve);
      hook.once("error", reject);
    }),
  ).toBe(0);
  await page.reload();
  await expect(card).toHaveCount(0);
  const cancelled = await apiGet<HumanRequest>(request, `/human-requests/${entry.id}`);
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.delivered_at).toBeNull();
});

test("should save attention retention and retain it after reloading settings", async ({ page }) => {
  await gotoView(page, "settings");
  await page.goto("/settings?settingsSection=notifications");
  const input = page.getByTestId("attention-retention-hours");
  await expect(input).toHaveValue("72");
  await input.fill("48");
  await page.getByTestId("attention-retention-save").click();
  await expect(page.getByTestId("attention-retention-saved")).toBeVisible();
  await page.reload();
  await expect(input).toHaveValue("48");
  await input.fill("72");
  await page.getByTestId("attention-retention-save").click();
  await expect(page.getByTestId("attention-retention-saved")).toBeVisible();
});

test("should continue a waiting CLI after answering through the reloaded inbox", async ({
  page,
  request,
}) => {
  const origin = tid("cli-human");
  const child = spawn("bun", ["packages/cli/src/index.ts", "attention", "request", "-", "--wait"], {
    cwd: repoRoot(),
    env: {
      ...process.env,
      ORC_API_HOST: "127.0.0.1",
      ORC_API_SECRET: process.env.ORC_API_SECRET ?? "",
      ORC_API_PORT: process.env.PW_API_PORT ?? "7799",
    },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 45000,
  });
  let output = "";
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk.toString();
  });
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  child.stdin.write(
    JSON.stringify({
      kind: "question",
      prompt: "Choose the demo color",
      choices: ["Blue", "Green"],
      choice_descriptions: { Blue: "Use the blue theme for the demo" },
      origin: { backend: "external-cli", session_id: origin, request_id: "color" },
    }),
  );
  child.stdin.end();
  try {
    await gotoView(page, "attention");
    await expect
      .poll(async () => {
        if (child.exitCode !== null) throw new Error(`CLI exited ${child.exitCode}: ${errors}`);
        return (await apiGet<HumanRequest[]>(request, "/human-requests")).find(
          (entry) => entry.input.origin.session_id === origin,
        )?.id;
      })
      .toBeTruthy();
    const pending = (await apiGet<HumanRequest[]>(request, "/human-requests")).find(
      (entry) => entry.input.origin.session_id === origin,
    );
    if (!pending) throw new Error("CLI did not create request");
    await page.reload();
    const card = page.getByTestId(`attention-request-${pending.id}`);
    await expect(card.getByTestId("attention-choice-Blue")).toContainText(
      "Use the blue theme for the demo",
    );
    await card.getByTestId("attention-choice-Blue").click();
    await card.getByTestId("attention-send").click();
    await expect(card.getByTestId("attention-response")).toHaveText("Blue");
    expect(await exited).toBe(0);
    const delivered = JSON.parse(output) as HumanRequest;
    expect(delivered.id).toBe(pending.id);
    expect(delivered.response).toEqual({ kind: "question", answer: "Blue" });
    const duplicate = await request.post(`${API_BASE}/human-requests/${pending.id}/respond`, {
      headers: AUTH_HEADERS,
      data: { version: 1, response: { kind: "question", answer: "Green" } },
    });
    expect(duplicate.status()).toBe(409);
    await apiPost(request, `/human-requests/${pending.id}/acknowledge`, { version: 2 });
    await expect(card).toHaveCount(0);
  } finally {
    if (child.exitCode === null) child.kill();
  }
});

test("should show exact approval action, retain denial after reload and allow free text", async ({
  page,
  request,
}) => {
  const approval = await apiPost<HumanRequest>(request, "/human-requests", {
    kind: "approval",
    prompt: "Allow this read-only command?",
    origin: { backend: "claude", session_id: tid("approval"), request_id: "approval" },
    action: { tool: "Bash", input: { command: "pwd" }, cwd: "/workspace", host: "demo-host" },
  });
  await gotoView(page, "attention");
  const card = page.getByTestId(`attention-request-${approval.id}`);
  await expect(card.getByTestId("attention-action")).toContainText("pwd");
  await page.screenshot({
    path: join(repoRoot(), ".claude/docs/human-requests-inbox.png"),
    fullPage: true,
  });
  await card.getByTestId("attention-deny").click();
  await page.reload();
  await expect(card.getByTestId("attention-response")).toHaveText("Denied");
  const question = await apiPost<HumanRequest>(request, "/human-requests", {
    kind: "question",
    prompt: "What should I name it?",
    origin: { backend: "codex", session_id: tid("free-text"), request_id: "name" },
  });
  const questionCard = page.getByTestId(`attention-request-${question.id}`);
  await questionCard.getByTestId("attention-answer").fill("Ocean blue");
  await questionCard.getByTestId("attention-send").click();
  await expect(questionCard.getByTestId("attention-response")).toHaveText("Ocean blue");
});

test("should preserve multiple selections and cancel a pending request", async ({
  page,
  request,
}) => {
  const question = await apiPost<HumanRequest>(request, "/human-requests", {
    kind: "question",
    prompt: "Which checks?",
    choices: ["Unit", "Browser"],
    multi_select: true,
    origin: { backend: "claude", session_id: tid("multi"), request_id: "checks" },
  });
  await gotoView(page, "attention");
  const card = page.getByTestId(`attention-request-${question.id}`);
  await card.getByTestId("attention-choice-Unit").click();
  await card.getByTestId("attention-choice-Browser").click();
  await card.getByTestId("attention-send").click();
  await expect(card.getByTestId("attention-response")).toHaveText("Unit, Browser");
  const answered = await apiGet<HumanRequest>(request, `/human-requests/${question.id}`);
  expect(answered.response).toEqual({
    kind: "question",
    answer: "Unit, Browser",
    selected_choices: ["Unit", "Browser"],
  });
  const pending = await apiPost<HumanRequest>(request, "/human-requests", {
    kind: "question",
    prompt: "Cancel me",
    origin: { backend: "codex", session_id: tid("cancel"), request_id: "cancel" },
  });
  const cancelledCard = page.getByTestId(`attention-request-${pending.id}`);
  await cancelledCard.getByTestId("attention-cancel").click();
  await expect(cancelledCard).toHaveCount(0);
  expect((await apiGet<HumanRequest>(request, `/human-requests/${pending.id}`)).status).toBe(
    "cancelled",
  );
});

test("should preserve Ask user expiry and notification settings when editing its prompt", async ({
  page,
  request,
}) => {
  const workspace = mkdtempSync(join(tmpdir(), "orc-ask-rule-browser-"));
  await apiPost(request, "/rules/activate", {
    expected_id: null,
    reason: "Human pause setup",
    policy: {
      workspace,
      project_id: null,
      rules: [
        {
          id: "native-question",
          kind: "event",
          enabled: true,
          reason: "Answer native questions",
          scope: { agents: ["claude"], events: ["runtime:question_request"] },
          filter: { match: "all", conditions: [] },
          target: {
            type: "ask_user",
            kind: "question",
            prompt: "Agent question",
            expires_in_seconds: 1800,
            notify: ["telegram"],
          },
        },
      ],
    },
  });
  await gotoView(page, "rules");
  const saved = page
    .getByTestId("rule-revision")
    .filter({ hasText: workspace })
    .getByTestId("saved-event-rule");
  await saved.getByTestId("event-rule-edit").click();
  await expect(page.getByTestId("rule-request-expiry")).toHaveValue("1800");
  await expect(page.getByTestId("rule-notify-telegram")).toBeChecked();
  await page.getByTestId("rule-request-prompt").fill("Updated question prompt");
  await page.getByTestId("event-rule-save").click();
  await page.reload();
  await saved.getByTestId("event-rule-edit").click();
  await expect(page.getByTestId("rule-request-expiry")).toHaveValue("1800");
  await expect(page.getByTestId("rule-notify-telegram")).toBeChecked();
  await expect(page.getByTestId("rule-request-prompt")).toHaveValue("Updated question prompt");
});
