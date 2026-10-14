import { afterEach, beforeEach, expect, test } from "bun:test";
import { type AgentSession, registerBackend } from "@orc/agent-runtime";
import { resetConfig } from "@orc/core/config";
import { getSqlite } from "@orc/db/client";
import { DIGEST_JOB_NAME, DigestStore } from "@orc/db/digest";
import { MemoryStore } from "@orc/db/memories";
import { SkillHistory } from "@orc/db/skill-history";
import { executeTool } from "@orc/mcp/tools";
import { runKnowledgeDigest } from "@orc/runner/knowledge-digest";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof setupTestApp>;
beforeEach(() => {
  app = setupTestApp();
});
afterEach(teardownTestApp);

const lesson = {
  project_id: null,
  slug: "verified-learning",
  kind: "procedure",
  title: "Knowledge loop validation",
  summary: "Validate failure rollback and persistence",
  content: "A verified procedure includes observed behavior and its limitations.",
  note: "Observed during validation",
  expected_revision: 0,
};

test("should reuse wiki lessons in ordinary search without putting them in startup context", async () => {
  const memory = new MemoryStore(getSqlite()).store({
    content: "reuseprobeneedle failed requests must preserve content and audit state",
  });
  if (memory.status !== "added") throw new Error("fixture was not added");
  await req(app, "POST", "/wiki", {
    ...lesson,
    title: "reuseprobeneedle procedure",
    sources: [`memory:${memory.id}`],
  });
  const search = await executeTool("search", {
    query: "reuseprobeneedle",
    resources: ["wiki", "memories"],
  });
  expect(search).toContain("## Wiki");
  expect(search).toContain(lesson.summary);
  expect(search).not.toContain(`[memory] ${memory.id}`);
  expect(await executeTool("context", {})).not.toContain(lesson.summary);
  const ordinaryMemoryRead = await executeTool("memory_get", { ids: [memory.id] });
  expect(ordinaryMemoryRead).toContain("reuseprobeneedle");
});

test("should activate scoped skill edits, retain raw history, reject stale saves and revert manually", async () => {
  const project = await (await req(app, "POST", "/projects", { name: "skill-learning" })).json();
  const name = "orc-coder";
  const baseline = await (await req(app, "GET", `/skills/${name}?ref=SKILL.md`)).json();
  const content = `${baseline.content}\n\n## Validated learning\nCheck rollback before reporting success.\n`;
  const update = {
    project_id: project.id,
    expected_content: baseline.content,
    content,
    reason: "Verified rollback procedure",
    author: "codex",
    wiki_pages: [],
  };
  const response = await req(app, "PUT", `/skills/${name}/instructions`, update);
  expect(response.status).toBe(200);
  const edited = await response.json();
  expect(edited.content).toContain("Check rollback");
  expect(edited.mutation).toMatchObject({ project_id: project.id, author: "codex" });
  expect((await req(app, "PUT", `/skills/${name}/instructions`, update)).status).toBe(409);
  const raw = await (
    await req(app, "GET", `/skills/${name}?ref=SKILL.md&project_id=${project.id}`)
  ).json();
  expect(raw.content).toBe(content);
  expect(
    await executeTool("skill_read", { name, ref: "SKILL.md", project: project.name }),
  ).toContain("Check rollback");
  const untouched = await (
    await req(app, "GET", `/skills/${name}?ref=SKILL.md&scope=global`)
  ).json();
  expect(untouched.content).toBe(baseline.content);
  const history = await (
    await req(app, "GET", `/skills/${name}/history?project_id=${project.id}`)
  ).json();
  expect(history.changes[0].previous_raw).toBe(baseline.content);
  const result = await req(app, "POST", `/skills/${name}/revert`, {
    project_id: project.id,
    change_id: edited.mutation.id,
    expected_change_id: edited.mutation.id,
    reason: "Human requested original procedure",
  });
  expect(result.status).toBe(200);
  const restored = await (
    await req(app, "GET", `/skills/${name}?ref=SKILL.md&project_id=${project.id}`)
  ).json();
  expect(restored.content).toBe(baseline.content);
  const audit = await (
    await req(app, "GET", `/audit?project_id=${project.id}&entity_type=skill`)
  ).json();
  expect(audit.entries.map((entry: { action: string }) => entry.action)).toEqual([
    "skill.reverted",
    "skill.updated",
  ]);
});

test("should retain the latest skill change after the 90-day history cutoff", () => {
  const history = new SkillHistory(getSqlite());
  const raw = history.read("orc-coder", null, "SKILL.md");
  if (!raw || !("encoding" in raw)) throw new Error("Missing raw instructions");
  const first = history.update({
    project_id: null,
    skill_name: "orc-coder",
    expected_content: raw.content,
    content: `${raw.content}\nFirst lesson`,
    reason: "first",
  });
  const second = history.update({
    project_id: null,
    skill_name: "orc-coder",
    expected_content: `${raw.content}\nFirst lesson`,
    content: `${raw.content}\nSecond lesson`,
    reason: "second",
  });
  if (!second.mutation) throw new Error("Missing mutation metadata");
  getSqlite().query("UPDATE skill_changes SET created_at=1").run();
  history.prune();
  expect(history.history("orc-coder", null).map((change) => change.id)).toEqual([
    second.mutation?.id,
  ]);
  expect(first.mutation?.id).not.toBe(second.mutation?.id);
  expect(history.history("orc-coder", null)[0]?.previous_raw).toContain("First lesson");
});

test("should seed one enabled daily job and skip agents when no new knowledge exists", async () => {
  expect(
    getSqlite()
      .query("SELECT enabled,trigger_type,skill_name FROM jobs WHERE name=?")
      .get(DIGEST_JOB_NAME),
  ).toEqual({ enabled: 1, trigger_type: "cron", skill_name: "orc-wiki" });
  let calls = 0;
  expect(
    await runKnowledgeDigest(async () => {
      calls++;
    }),
  ).toContain("No new knowledge");
  expect(calls).toBe(0);
});

test("should claim each changed scope once, keep failures retryable and preserve writes after the captured cursor", async () => {
  const project = await (await req(app, "POST", "/projects", { name: "digest-learning" })).json();
  const memories = new MemoryStore(getSqlite());
  memories.store({ project_id: project.id, content: "digestneedle verified original behavior" });
  const store = new DigestStore(getSqlite());
  const first = store.claim(project.id);
  if (!first) throw new Error("No digest claim");
  expect(first.memories).toHaveLength(1);
  expect(store.claim(project.id)).toBeNull();
  store.fail(first.token, "Failure before completion");
  const retry = store.claim(project.id);
  if (!retry) throw new Error("No retry");
  expect(retry.memories).toHaveLength(1);
  memories.store({
    project_id: project.id,
    content: "digestneedle a different new observation during processing",
  });
  store.complete(retry.token, "applied", "Reviewed original observation");
  expect(() => store.complete(retry.token, "applied", "Duplicate callback")).toThrow();
  const next = store.claim(project.id);
  expect(next?.memories).toHaveLength(1);
  if (next) store.complete(next.token, "no_change", "Insufficient new evidence");
  expect(store.claim(project.id)).toBeNull();
});

test("should run the digest through its agent boundary and require explicit completion", async () => {
  new MemoryStore(getSqlite()).store({ content: "digestflowneedle failure rollback verified" });
  let calls = 0;
  await runKnowledgeDigest(async (input) => {
    calls++;
    await req(app, "POST", "/wiki", { ...lesson, sources: [`memory:${input.memories[0]?.id}`] });
    await executeTool("digest_complete", {
      token: input.token,
      outcome: "applied",
      note: "Compiled verified rollback lesson",
    });
  });
  expect(calls).toBe(1);
  await runKnowledgeDigest(async () => {
    calls++;
  });
  expect(calls).toBe(1);
  new MemoryStore(getSqlite()).store({ content: "digestflowneedle further observations" });
  await expect(runKnowledgeDigest(async () => {})).rejects.toThrow("failed");
  expect(new DigestStore(getSqlite()).claim(null)).not.toBeNull();
});

test("should not treat an expired or replaced digest token as a completed run", () => {
  new MemoryStore(getSqlite()).store({ content: "Lease expiry observation" });
  const store = new DigestStore(getSqlite());
  const first = store.claim(null);
  if (!first) throw new Error("No initial claim");
  getSqlite().query("UPDATE knowledge_digests SET expires_at=1").run();
  const next = store.claim(null);
  if (!next) throw new Error("No replacement claim");
  expect(store.completed(first.token)).toBe(false);
  expect(() => store.complete(first.token, "no_change", "Expired claim")).toThrow();
  store.complete(next.token, "no_change", "Reviewed current claim");
  expect(store.completed(next.token)).toBe(true);
});

test("should execute the actual session driver with MCP tools and persist the worker lifecycle", async () => {
  const previous = process.env.ORC_AGENT_LOOP_DEFAULT_BACKEND;
  let closed = false;
  const session: AgentSession = {
    id: "digest-native-test",
    async send(prompt) {
      const input = JSON.parse(prompt.slice(prompt.indexOf("Digest input:") + 13)) as {
        token: string;
      };
      await executeTool("digest_complete", {
        token: input.token,
        outcome: "no_change",
        note: "Insufficient new evidence",
      });
    },
    async *events() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      yield { type: "result", data: {} };
    },
    respondPermission() {},
    alive() {
      return true;
    },
    async close() {
      closed = true;
    },
  };
  registerBackend("knowledge-driver-test", () => ({
    name: "knowledge-driver-test",
    async preflight() {
      return { ok: true };
    },
    async startSession(options) {
      expect(options.toolAllowlist).toContain("mcp__orc__digest_complete");
      expect(options.ruleBuiltinActions).toBe(false);
      return session;
    },
    async resumeSession() {
      return session;
    },
    async stop() {},
  }));
  try {
    process.env.ORC_AGENT_LOOP_DEFAULT_BACKEND = "knowledge-driver-test";
    resetConfig();
    new MemoryStore(getSqlite()).store({ content: "Actual session-driver control" });
    await runKnowledgeDigest();
    expect(
      getSqlite()
        .query(
          "SELECT status,runtime_session_id,mode FROM gateway_sessions WHERE mode='knowledge-digest'",
        )
        .get(),
    ).toEqual({
      status: "stopped",
      runtime_session_id: "digest-native-test",
      mode: "knowledge-digest",
    });
    expect(closed).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.ORC_AGENT_LOOP_DEFAULT_BACKEND;
    else process.env.ORC_AGENT_LOOP_DEFAULT_BACKEND = previous;
    resetConfig();
  }
});

test("should leave digest inputs untouched when the overall job budget is exhausted", async () => {
  new MemoryStore(getSqlite()).store({ content: "Deferred digest budget observation" });
  let calls = 0;
  await expect(
    runKnowledgeDigest(async () => {
      calls++;
    }, 0),
  ).rejects.toThrow("timeout");
  expect(calls).toBe(0);
  expect(new DigestStore(getSqlite()).claim(null)?.memories).toHaveLength(1);
});

test("should identify work-unit memories explicitly and expose tags for review", async () => {
  const result = await executeTool("memory_store", {
    content: "Session ownership review note",
    tags: ["transactions"],
    session_id: "review-owned-session",
  });
  const id = result.replace("Stored: ", "").split(/\s/)[0];
  if (!id) throw new Error("Missing memory ID");
  expect(await executeTool("memory_get", { ids: [id] })).toContain('tags: ["transactions"]');
  await executeTool("memory_update", {
    id,
    tags: ["transactions", "outcome:verified"],
    session_id: "review-owned-session",
  });
  const audit = JSON.parse(
    await executeTool("audit_list", { session_id: "review-owned-session", scope: "global" }),
  );
  expect(audit.entries.map((entry: { action: string }) => entry.action)).toEqual([
    "memory.updated",
    "memory.created",
  ]);
});
