import { afterAll, beforeAll, expect, test } from "bun:test";
import { getSqlite } from "@orc/db/client";
import { contributeStoppedSession } from "@orc/db/session-contributions";
import { getSkillSnapshot } from "@orc/db/skill-evolution";
import { WikiStore } from "@orc/db/wiki";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
beforeAll(() => {
  app = setupTestApp();
});
afterAll(teardownTestApp);

test("should enforce authentication and reject invalid retrieval input", async () => {
  expect((await app.request("/api/knowledge/wiki")).status).toBe(401);
  expect(
    (
      await req(app, "POST", "/knowledge/passages/search", {
        query: "x",
        project_id: null,
        limit: 999,
      })
    ).status,
  ).toBe(400);
});

test("should read cited evidence, save wiki revisions, and isolate projects through the API", async () => {
  const projectResponse = await req(app, "POST", "/projects", { name: "wiki-api" });
  const project = await projectResponse.json();
  const wiki = new WikiStore(getSqlite());
  const id = wiki.enqueue({
    kind: "session",
    source_id: "api-session",
    project_id: project.id,
    title: "Incident",
    content: "The process tree retains the socket after its launcher exits.",
    location: "orc://sessions/api-session",
  });
  const search = await req(app, "POST", "/knowledge/passages/search", {
    query: "process tree",
    project_id: project.id,
  });
  expect(search.status).toBe(200);
  const result = await search.json();
  expect(result.capabilities.semantic).toBe("off");
  const edit = {
    slug: "socket-ownership",
    expected_revision: 0,
    title: "Socket ownership",
    content: "Check child processes before restarting.",
    tags: ["windows"],
    evidence: result.passages.map((p: { id: string }) => p.id),
    summary: "Root cause retained",
  };
  const apply = await req(app, "POST", "/knowledge/wiki/apply", {
    contribution_id: id,
    project_id: project.id,
    outcome: "applied",
    summary: "Lesson documented",
    edits: [edit],
  });
  expect(apply.status).toBe(200);
  const read = await req(
    app,
    "GET",
    `/knowledge/wiki?project_id=${project.id}&slug=socket-ownership`,
  );
  const page = await read.json();
  expect(page.pages[0].revision).toBe(1);
  expect(page.history).toHaveLength(1);
  expect(page.attempts).toHaveLength(1);
  expect(page.attempts[0].outcome).toBe("applied");
  const unassigned = await (await req(app, "GET", "/knowledge/wiki")).json();
  expect(unassigned.pages).toHaveLength(0);
  expect(unassigned.attempts).toHaveLength(0);
  const expansion = await req(app, "POST", "/knowledge/passages/expand", {
    id: result.passages[0].id,
    project_id: null,
  });
  expect((await expansion.json()).passages).toHaveLength(0);
});

test("should queue bounded maintenance tasks and retain three failed attempts", () => {
  const wiki = new WikiStore(getSqlite());
  const contribution = wiki.enqueue({
    kind: "session",
    source_id: "retry-session",
    project_id: null,
    title: "Retry incident",
    content: "An agent exited before recording a verified result.",
    location: "orc://sessions/retry-session",
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    expect(wiki.schedule()).toBe(1);
    const row = wiki.contributions(null).find((entry) => entry.id === contribution);
    expect(row?.attempts).toBe(attempt);
    expect(wiki.schedule()).toBe(0);
    wiki.finishTask(row?.task_id ?? "", "backend unavailable");
  }
  expect(wiki.schedule()).toBe(0);
  expect(wiki.contributions(null).find((entry) => entry.id === contribution)?.status).toBe(
    "failed",
  );
  expect(
    getSqlite()
      .query("SELECT count(*) AS count FROM wiki_contribution_attempts WHERE contribution_id=?")
      .get(contribution),
  ).toEqual({ count: 3 });
  expect(
    wiki
      .attempts(null)
      .filter((entry) => entry.contribution_id === contribution)
      .map((entry) => entry.outcome),
  ).toEqual(["failed", "failed", "failed"]);
});

test("should recover cancelled maintenance tasks without blocking the contribution queue", () => {
  const wiki = new WikiStore(getSqlite());
  const id = wiki.enqueue({
    kind: "session",
    source_id: "cancelled-maintenance",
    project_id: null,
    title: "Cancelled task",
    content: "A maintenance task was cancelled before reporting.",
    location: "orc://sessions/cancelled-maintenance",
  });
  expect(wiki.schedule()).toBe(1);
  const task = wiki.contributions(null).find((entry) => entry.id === id)?.task_id;
  getSqlite()
    .query("UPDATE tasks SET status='cancelled' WHERE id=?")
    .run(task ?? "");
  expect(wiki.schedule()).toBe(1);
  const retried = wiki.contributions(null).find((entry) => entry.id === id);
  expect(retried?.task_id).not.toBe(task);
  expect(retried?.attempts).toBe(2);
  expect(
    getSqlite()
      .query("SELECT count(*) AS count FROM wiki_contribution_attempts WHERE contribution_id=?")
      .get(id),
  ).toEqual({ count: 1 });
  wiki.finishTask(retried?.task_id ?? "", "Test complete");
  expect(wiki.schedule()).toBe(1);
  const finalAttempt = wiki.contributions(null).find((entry) => entry.id === id);
  wiki.finishTask(finalAttempt?.task_id ?? "", "Fixture exhausted its final attempt");
});

test("should retain original memory versions through updates and retirement", async () => {
  const created = await (
    await req(app, "POST", "/memories", {
      content: "Original socket ownership decision",
      tags: ["Windows"],
    })
  ).json();
  expect(
    (
      await req(app, "PATCH", `/memories/${created.id}`, {
        content: "Revised socket ownership decision",
      })
    ).status,
  ).toBe(200);
  expect(
    getSqlite()
      .query("SELECT count(*) AS count FROM evidence_versions WHERE kind='memory' AND source_id=?")
      .get(created.id),
  ).toEqual({ count: 2 });
  const historical = getSqlite()
    .query<{ id: string }, [string]>(
      "SELECT id FROM evidence_passages WHERE source_id=? AND content LIKE 'Original%' LIMIT 1",
    )
    .get(created.id);
  expect((await req(app, "DELETE", `/memories/${created.id}`)).status).toBe(204);
  const search = await (
    await req(app, "POST", "/knowledge/passages/search", {
      query: "socket ownership",
      project_id: null,
      kinds: ["memory"],
    })
  ).json();
  expect(search.passages).toEqual([]);
  const citation = await (
    await req(app, "POST", "/knowledge/passages/get", { ids: [historical?.id], project_id: null })
  ).json();
  expect(citation.passages[0].content).toContain("Original socket ownership");
  const foreign = await (
    await req(app, "POST", "/knowledge/passages/get", {
      ids: [historical?.id],
      project_id: "other",
    })
  ).json();
  expect(foreign.passages).toEqual([]);
  expect(
    getSqlite()
      .query("SELECT count(*) AS count FROM evidence_versions WHERE kind='memory' AND source_id=?")
      .get(created.id),
  ).toEqual({ count: 2 });
});

test("should automatically queue skill evaluations, retain failures and stop after three attempts", async () => {
  const wiki = new WikiStore(getSqlite());
  const source_id = "evaluation-queue";
  const indexed = await req(app, "POST", "/knowledge/passages/index", {
    kind: "session",
    source_id,
    project_id: null,
    title: "Observed lesson",
    content: "Socket ownership evidence supports a candidate procedure.",
    location: "orc://sessions/evaluation-queue",
  });
  expect(indexed.status).toBe(200);
  const retrieved = await (
    await req(app, "POST", "/knowledge/passages/search", {
      query: "supports candidate",
      project_id: null,
      kinds: ["session"],
    })
  ).json();
  const baseline = getSkillSnapshot(getSqlite(), "orc-worker-base", null);
  const id = wiki.propose({
    project_id: null,
    skill_name: "orc-worker-base",
    baseline_hash: baseline.hash,
    candidate: `${baseline.raw}\nInspect ownership.\n`,
    evidence: retrieved.passages.map((p: { id: string }) => p.id),
    rationale: "Queue mechanics test",
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    expect(wiki.schedule()).toBe(1);
    const job = getSqlite()
      .query<{ task_id: string; attempts: number }, [string]>(
        "SELECT task_id,attempts FROM skill_evaluation_jobs WHERE proposal_id=?",
      )
      .get(id);
    expect(job?.attempts).toBe(attempt);
    expect(wiki.schedule()).toBe(0);
    wiki.finishTask(job?.task_id ?? "", "Representative executable suite unavailable");
  }
  expect(wiki.schedule()).toBe(0);
  expect(
    getSqlite()
      .query(
        "SELECT count(*) AS count FROM skill_evaluations WHERE proposal_id=? AND result='evaluator_failed'",
      )
      .get(id),
  ).toEqual({ count: 3 });
  expect(getSqlite().query("SELECT count(*) AS count FROM skill_activations").get()).toEqual({
    count: 0,
  });
});

test("should retain abnormal session exits once and avoid recursive wiki-session contributions", async () => {
  const sqlite = getSqlite();
  sqlite
    .query(
      "INSERT INTO bridge_chats(id,platform,chat_id) VALUES('wiki-lifecycle-chat','telegram','isolated-test')",
    )
    .run();
  sqlite
    .query(
      "INSERT INTO gateway_sessions(id,chat_id,backend,mode,status,last_error) VALUES('wiki-abnormal-exit','wiki-lifecycle-chat','test','direct','error','Agent crashed before validation')",
    )
    .run();
  const id = contributeStoppedSession(sqlite, "wiki-abnormal-exit");
  expect(id).toBeTruthy();
  expect(contributeStoppedSession(sqlite, "wiki-abnormal-exit")).toBe(id);
  const evidence = await (
    await req(app, "POST", "/knowledge/passages/search", {
      query: "Agent crashed",
      project_id: null,
      kinds: ["session"],
    })
  ).json();
  expect(
    evidence.passages.some((p: { content: string }) =>
      p.content.includes("Recorded failure: Agent crashed before validation"),
    ),
  ).toBe(true);
  sqlite
    .query(
      "INSERT INTO tasks(id,title,skill_name) VALUES('wiki-recursion-task','Maintenance','orc-wiki')",
    )
    .run();
  sqlite
    .query(
      "INSERT INTO gateway_sessions(id,chat_id,backend,mode,status,task_id) VALUES('wiki-recursive-exit','wiki-lifecycle-chat','test','direct','stopped','wiki-recursion-task')",
    )
    .run();
  expect(contributeStoppedSession(sqlite, "wiki-recursive-exit")).toBeNull();
});

test("should scope maintenance reads by explicit ID or null before installation project defaults", async () => {
  const projects = await (await req(app, "GET", "/projects")).json();
  const project = projects.projects.find((entry: { name: string }) => entry.name === "wiki-api");
  const read = await req(app, "POST", "/mcp/tool", {
    name: "wiki_read",
    args: { project_id: project.id, project: "not-the-assigned-project" },
  });
  expect(read.status).toBe(200);
  expect(await read.text()).toContain("Socket ownership");
  const unassigned = await req(app, "POST", "/mcp/tool", {
    name: "wiki_read",
    args: { project_id: null, project: "not-the-assigned-project" },
  });
  expect(unassigned.status).toBe(200);
  expect(await unassigned.text()).not.toContain("Lesson documented");
  for (const name of ["skill_history", "skill_baseline"]) {
    const result = await req(app, "POST", "/mcp/tool", {
      name,
      args: { name: "orc-worker-base", project_id: null, project: "not-the-assigned-project" },
    });
    expect(result.status).toBe(200);
  }
  const unknown = await req(app, "POST", "/mcp/tool", {
    name: "wiki_read",
    args: { project_id: "missing-project", project: "wiki-api" },
  });
  expect(unknown.status).toBe(404);
});
