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

async function createProject(name: string): Promise<{ id: string; name: string }> {
  return (await req(app, "POST", "/projects", { name })).json();
}

function remember(projectId: string, name: string, content: string) {
  return new MemoryStore(getSqlite()).create({
    project_id: projectId,
    name,
    description: content.slice(0, 80),
    content,
  });
}

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
  const project = await createProject("reuse-learning");
  const memory = remember(
    project.id,
    "reuse-probe",
    "reuseprobeneedle failed requests must preserve content and audit state",
  );
  await req(app, "POST", "/wiki", {
    ...lesson,
    project_id: project.id,
    title: "reuseprobeneedle procedure",
    sources: [`memory:${memory.name}`],
  });
  const search = await executeTool("search", {
    query: "reuseprobeneedle",
    resources: ["wiki", "memories"],
    project: project.name,
  });
  expect(search).toContain("## Wiki");
  expect(search).toContain(lesson.summary);
  expect(search).not.toContain("[memory]");
  expect(await executeTool("context", { project: project.name })).not.toContain(lesson.summary);
  const ordinaryMemoryRead = await executeTool("memory_read", {
    name: memory.name,
    project: project.name,
  });
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
  const project = await createProject("digest-learning");
  remember(project.id, "digest-original", "digestneedle verified original behavior");
  const store = new DigestStore(getSqlite());
  const first = store.claim(project.id);
  if (!first) throw new Error("No digest claim");
  expect(first.memories).toHaveLength(1);
  expect(store.claim(project.id)).toBeNull();
  store.fail(first.token, "Failure before completion");
  const retry = store.claim(project.id);
  if (!retry) throw new Error("No retry");
  expect(retry.memories).toHaveLength(1);
  remember(project.id, "digest-new", "digestneedle a different new observation during processing");
  store.complete(retry.token, "applied", "Reviewed original observation");
  expect(() => store.complete(retry.token, "applied", "Duplicate callback")).toThrow();
  const next = store.claim(project.id);
  expect(next?.memories).toHaveLength(1);
  if (next) store.complete(next.token, "no_change", "Insufficient new evidence");
  expect(store.claim(project.id)).toBeNull();
});

test("should run the digest through its agent boundary and require explicit completion", async () => {
  const project = await createProject("digest-flow");
  remember(project.id, "digest-flow", "digestflowneedle failure rollback verified");
  let calls = 0;
  await runKnowledgeDigest(async (input) => {
    calls++;
    expect(input.memories.map((m) => m.name)).toEqual(["digest-flow"]);
    await req(app, "POST", "/wiki", {
      ...lesson,
      project_id: project.id,
      sources: [`memory:${input.memories[0]?.name}`],
    });
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
  remember(project.id, "digest-flow-more", "digestflowneedle further observations");
  await expect(runKnowledgeDigest(async () => {})).rejects.toThrow("failed");
  expect(new DigestStore(getSqlite()).claim(project.id)).not.toBeNull();
});

test("should not treat an expired or replaced digest token as a completed run", async () => {
  const project = await createProject("digest-lease");
  remember(project.id, "lease-expiry", "Lease expiry observation");
  const store = new DigestStore(getSqlite());
  const first = store.claim(project.id);
  if (!first) throw new Error("No initial claim");
  getSqlite().query("UPDATE knowledge_digests SET expires_at=1").run();
  const next = store.claim(project.id);
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
    remember((await createProject("digest-driver")).id, "driver", "Actual session-driver control");
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
  const project = await createProject("digest-budget");
  remember(project.id, "budget", "Deferred digest budget observation");
  let calls = 0;
  await expect(
    runKnowledgeDigest(async () => {
      calls++;
    }, 0),
  ).rejects.toThrow("timeout");
  expect(calls).toBe(0);
  expect(new DigestStore(getSqlite()).claim(project.id)?.memories).toHaveLength(1);
});

test("should attribute memory changes to the agent session for review", async () => {
  const project = await createProject("review-learning");
  const session = { agentSessionId: "review-owned-session" };
  await executeTool(
    "memory_create",
    {
      name: "session-ownership",
      description: "Review note",
      content: "Session ownership review note",
      project: project.name,
    },
    session,
  );
  await executeTool(
    "memory_update",
    { name: "session-ownership", priority: 60, reason: "verified", project: project.name },
    session,
  );
  const audit = JSON.parse(
    await executeTool("audit_list", { session_id: "review-owned-session", project: project.name }),
  );
  expect(audit.entries.map((entry: { action: string }) => entry.action)).toEqual([
    "memory.updated",
    "memory.created",
  ]);
  expect(
    audit.entries.every((entry: { subject_ids: string[] }) =>
      entry.subject_ids.includes("session-ownership"),
    ),
  ).toBe(true);
});
