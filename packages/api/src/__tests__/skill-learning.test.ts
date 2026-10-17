import { afterEach, beforeEach, expect, test } from "bun:test";
import { getSqlite } from "@orc/db/client";
import { SkillHistory } from "@orc/db/skill-history";
import { executeTool } from "@orc/mcp/tools";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof setupTestApp>;
beforeEach(() => {
  app = setupTestApp();
});
afterEach(teardownTestApp);

async function createProject(name: string): Promise<{ id: string; name: string }> {
  return (await req(app, "POST", "/projects", { name })).json();
}

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

test("should protect audit reads and validate inputs", async () => {
  expect((await app.request("/api/audit")).status).toBe(401);
  expect((await req(app, "GET", "/audit?limit=101")).status).toBe(400);
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
