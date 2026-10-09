import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { apiGet, apiPost, gotoView, repoRoot, tid } from "./_helpers";

test("wiki persists cited pages and retrieves real repository evidence without embeddings", async ({
  page,
  request,
}) => {
  const project = await apiPost<{ id: string }>(request, "/projects", {
    name: tid("wiki-browser"),
  });
  const content = readFileSync(join(repoRoot(), "docs/task-flows.md"), "utf8");
  await apiPost(request, "/knowledge/passages/index", {
    kind: "document",
    source_id: tid("flow-manual"),
    project_id: project.id,
    title: "Task flow manual",
    content,
    location: "docs/task-flows.md",
    tags: ["flows"],
  });
  const search = await apiPost<{
    passages: { id: string; content: string; start: number; end: number }[];
    capabilities: { semantic: string };
  }>(request, "/knowledge/passages/search", { query: "join_deadlock", project_id: project.id });
  expect(search.capabilities.semantic).toBe("off");
  expect(search.passages.length).toBeGreaterThan(0);
  for (const passage of search.passages)
    expect(content.slice(passage.start, passage.end)).toBe(passage.content);
  await apiPost(request, "/mcp/tool", {
    name: "session_log",
    args: {
      agent: "browser-validation",
      project: (
        await apiGet<{ projects: { id: string; name: string }[] }>(request, "/projects")
      ).projects.find((p) => p.id === project.id)?.name,
      session_id: tid("browser-work-unit"),
      summary:
        "Verified that an unsatisfiable join halts the flow; documented in the task flow manual.",
    },
  });
  const wiki = await apiGet<{ contributions: { id: string }[] }>(
    request,
    `/knowledge/wiki?project_id=${project.id}`,
  );
  await apiPost(request, "/knowledge/wiki/apply", {
    contribution_id: wiki.contributions[0]?.id,
    project_id: project.id,
    outcome: "failed",
    summary: "Interrupted before consolidation",
  });
  await apiPost(request, "/knowledge/wiki/apply", {
    contribution_id: wiki.contributions[0]?.id,
    project_id: project.id,
    outcome: "applied",
    summary: "Documented join termination",
    edits: [
      {
        slug: "join-termination",
        expected_revision: 0,
        title: "Join termination",
        content:
          "An unsatisfiable join halts with join_deadlock. Inspect branch outcomes before resuming. See [[join-procedure]]. Code stays literal: `[[join-procedure]]`.",
        tags: ["flows"],
        evidence: search.passages.map((p) => p.id),
        summary: "Procedure derived from task flow documentation",
      },
      {
        slug: "join-procedure",
        expected_revision: 0,
        title: "Join procedure",
        content: "Inspect the flow ledger and branch outcomes before resuming.",
        tags: ["flows"],
        evidence: search.passages.map((p) => p.id),
        summary: "Linked procedure",
      },
    ],
  });
  await page.addInitScript(
    (id: string) => localStorage.setItem("orc_selected_project", id),
    project.id,
  );
  await gotoView(page, "knowledge");
  await page.getByTestId("knowledge-wiki-tab").click();
  await page.getByTestId("wiki-page-join-termination").click();
  await expect(page.getByTestId("wiki-page-content")).toContainText("revision 1");
  await page.reload();
  await page.getByTestId("wiki-page-join-termination").click();
  await expect(page.getByTestId("wiki-page-content")).toContainText("join_deadlock");
  await page.getByTestId("wiki-contribution").locator("summary").click();
  await expect(page.getByTestId("wiki-attempt-history")).toContainText(
    "Interrupted before consolidation",
  );
  await expect(page.getByTestId("wiki-attempt-history")).toContainText(
    "applied: Documented join termination",
  );
  await page.getByTestId("wiki-citation").first().click();
  await expect(page.getByTestId("wiki-cited-source")).toContainText("docs/task-flows.md");
  await expect(page.getByTestId("wiki-cited-source")).toContainText(
    search.passages[0]?.content ?? "",
  );
  await page.getByTestId("wiki-search-input").fill("join_deadlock");
  await page.getByTestId("wiki-search-submit").click();
  await expect(page.getByTestId("wiki-search-results")).toContainText("Semantic retrieval: off");
  await expect(page.getByTestId("wiki-search-results")).toContainText("docs/task-flows.md");
  await expect(page.getByTestId("wiki-link-join-procedure")).toHaveCount(1);
  await page.getByTestId("wiki-link-join-procedure").click();
  await expect(page.getByTestId("wiki-page-content")).toContainText("Inspect the flow ledger");
  await page.screenshot({ path: "../../output/playwright/wiki-evidence.png", fullPage: true });
});

test("automatic skill promotion exposes before/after history and a human revert action", async ({
  page,
  request,
}) => {
  const name = tid("skill-evolution-browser");
  const project = await apiPost<{ id: string }>(request, "/projects", { name });
  await apiPost(request, "/mcp/tool", {
    name: "session_log",
    args: {
      agent: "browser-validation",
      project: name,
      session_id: tid("skill-case"),
      summary: "The stopped-session incident showed that process-tree checks are necessary.",
    },
  });
  const evidence = await apiPost<{ passages: { id: string }[] }>(
    request,
    "/knowledge/passages/search",
    { query: "process tree", project_id: project.id },
  );
  const baseline = await apiGet<{ hash: string; raw: string }>(
    request,
    `/skills/evolution/baseline?name=orc-worker-base&project_id=${project.id}`,
  );
  const candidate = `${baseline.raw}\n\nCheck process-tree ownership before restarting a service.\n`;
  const proposal = await apiPost<{ id: string }>(request, "/skills/proposals", {
    project_id: project.id,
    skill_name: "orc-worker-base",
    baseline_hash: baseline.hash,
    candidate,
    rationale: "Controlled browser validation of the promotion gate",
    evidence: evidence.passages.map((p) => p.id),
    training_cases: ["source-incident"],
  });
  const evaluation = await apiPost<{ result: string }>(request, "/skills/evaluations", {
    proposal_id: proposal.id,
    project_id: project.id,
    suite: "browser-control-suite",
    cases: Array.from({ length: 10 }, (_, index) => ({
      id: `browser-held-out-${index}`,
      baseline: index < 5,
      candidate: true,
    })),
    validation_passed: true,
    notes:
      "Controlled outcomes validate UI and gate mechanics; they do not measure real agent improvement.",
  });
  expect(evaluation.result).toBe("activated");
  const active = await apiGet<{ content: string }>(
    request,
    `/skills/orc-worker-base?project_id=${project.id}`,
  );
  expect(active.content).toContain("Check process-tree ownership");
  await page.addInitScript(
    (id: string) => localStorage.setItem("orc_selected_project", id),
    project.id,
  );
  await gotoView(page, "skills");
  await page.getByTestId("skill-evolution-history").locator("summary").first().click();
  await expect(page.getByTestId("skill-activation")).toContainText("current");
  await page.reload();
  await page.getByTestId("skill-evolution-history").locator("summary").first().click();
  await page.getByTestId("skill-revert-reason").fill("Human rejected the scope of this procedure");
  await page.getByTestId("skill-revert-button").click();
  await expect(page.getByTestId("skill-revert-button")).toHaveCount(0);
  await expect(page.getByTestId("skill-evolution-history")).toContainText(
    "Human rejected the scope",
  );
  const reverted = await apiGet<{ raw: string }>(
    request,
    `/skills/evolution/baseline?name=orc-worker-base&project_id=${project.id}`,
  );
  expect(reverted.raw).toBe(baseline.raw);
});
