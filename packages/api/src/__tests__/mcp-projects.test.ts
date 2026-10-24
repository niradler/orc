import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkill, type SkillRefContent } from "@orc/core/skill-service";
import { getSqlite } from "@orc/db/client";
import { MemoryStore } from "@orc/db/memories";
import { SkillHistory } from "@orc/db/skill-history";
import { closeKnowledgeService, getKnowledgeService } from "@orc/knowledge";
import { setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof setupTestApp>;
let root: string;
const oldRoot = process.env.ORC_KNOWLEDGE_ROOT;
const kbs: Record<string, string> = {};
const docs: Record<string, string> = {};
const multi = "?projects=Alpha,Beta";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "orc-mcp-projects-"));
  process.env.ORC_KNOWLEDGE_ROOT = root;
  app = setupTestApp();
  const sqlite = getSqlite();
  sqlite.exec(
    "INSERT INTO projects(id,name) VALUES ('alpha','Alpha'),('beta','Beta'),('gamma','Gamma')",
  );
  for (const id of ["alpha", "beta", "gamma"]) {
    sqlite
      .query("INSERT INTO tasks(id,title,project_id,status,updated_at) VALUES(?,?,?,'todo',?)")
      .run(`task-${id}`, `needle task ${id}`, id, id === "gamma" ? 9999 : 1000);
    sqlite
      .query("INSERT INTO jobs(id,name,command,trigger_type,project_id) VALUES(?,?,?,'manual',?)")
      .run(`job-${id}`, `needle-job-${id}`, "echo unused", id);
    new MemoryStore(sqlite).create({
      project_id: id,
      name: "shared-note",
      description: `needle memory ${id}`,
      content: `${id} memory content`,
    });
  }
  sqlite
    .query(
      "INSERT INTO tasks(id,title,project_id,status,updated_at) VALUES('done-alpha','Closed task','alpha','done',20000)",
    )
    .run();
  const history = new SkillHistory(sqlite);
  history.setProjects("orc-platform", ["beta"]);
  history.setProjects("orc-sdlc", ["alpha", "beta"]);
  const raw = (readSkill("orc-sdlc", "SKILL.md") as SkillRefContent).content;
  for (const project of ["alpha", "beta"])
    history.update({
      skill_name: "orc-sdlc",
      project_id: project,
      expected_content: raw,
      content: `---\nname: orc-sdlc\ndescription: ${project} scoped instructions\n---\n${project.toUpperCase()} INSTRUCTIONS`,
      reason: "Fixture",
    });
  const svc = await getKnowledgeService();
  for (const id of ["alpha", "beta", "gamma", "global"]) {
    const kb = svc.createKb(
      { source: "ui", actor: {} },
      { name: `${id} runbook`, project_id: id === "global" ? null : id },
    );
    kbs[id] = kb.id;
    docs[id] = svc.createDocument({ source: "ui", actor: {} }, kb.id, {
      title: `${id} needle`,
      content: `# needle ${id}\n\nA unique needle procedure for ${id}.`,
    }).id;
  }
  await svc.jobs.idle();
});

afterAll(async () => {
  await closeKnowledgeService();
  teardownTestApp();
  if (oldRoot === undefined) delete process.env.ORC_KNOWLEDGE_ROOT;
  else process.env.ORC_KNOWLEDGE_ROOT = oldRoot;
  rmSync(root, { recursive: true, force: true });
});

async function rpc(query: string, name: string, args: Record<string, unknown> = {}, meta = false) {
  const response = await app.request(`/mcp${query}${meta ? "&mode=meta" : ""}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer test-secret",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: meta
        ? { name: "tool_invoke", arguments: { name, arguments: args } }
        : { name, arguments: args },
    }),
  });
  const body = await response.text();
  const data = JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1));
  return {
    status: response.status,
    text: data.result?.content?.[0]?.text as string | undefined,
    error: data.result?.isError,
  };
}

describe("connection-wide MCP project defaults", () => {
  test("should default all project-aware lists and context to one selected project", async () => {
    for (const tool of [
      "task_list",
      "job_list",
      "memory_list",
      "context",
      "project_list",
      "audit_list",
      "search",
    ]) {
      const result = await rpc(
        "?project=Alpha",
        tool,
        tool === "search" ? { query: "needle", resources: ["tasks", "memories"] } : {},
      );
      expect(result.error).not.toBe(true);
      expect(result.text).not.toContain("gamma");
      expect(result.text).not.toContain("needle task beta");
      expect(result.text).not.toContain("needle memory beta");
    }
    expect((await rpc("?project=Alpha", "task_list")).text).toContain("needle task alpha");
  });

  test("should union tasks/jobs/memories and search in both full and meta modes", async () => {
    for (const meta of [false, true]) {
      for (const tool of [
        "task_list",
        "job_list",
        "memory_list",
        "context",
        "project_list",
        "audit_list",
        "search",
      ]) {
        const result = await rpc(
          multi,
          tool,
          tool === "search" ? { query: "needle", resources: ["tasks", "memories"] } : {},
          meta,
        );
        expect(result.error).not.toBe(true);
        expect(result.text?.toLowerCase()).toContain("alpha");
        expect(result.text?.toLowerCase()).toContain("beta");
        expect(result.text?.toLowerCase()).not.toContain("gamma");
      }
      const limited = await rpc(multi, "task_list", { limit: 1 }, meta);
      expect(limited.text?.split("\n")).toHaveLength(1);
    }
  });

  test("should merge skills before pagination, select first applicable instructions and support explicit project", async () => {
    const first = await rpc(multi, "skill_list", { source: "builtin", limit: 1 });
    const second = await rpc(multi, "skill_list", { source: "builtin", limit: 1, offset: 1 });
    expect(first.text).toContain("total=2");
    expect(first.text).toContain("next_offset=1");
    expect(second.text).toContain("next_offset=null");
    const result = await rpc(multi, "skill_list", { source: "builtin" });
    expect(result.text?.match(/orc-sdlc/g)).toHaveLength(1);
    expect(result.text).toContain("orc-platform");
    expect((await rpc(multi, "skill_read", { name: "orc-sdlc" })).text).toContain(
      "ALPHA INSTRUCTIONS",
    );
    expect((await rpc("?projects=Beta,Alpha", "skill_read", { name: "orc-sdlc" })).text).toContain(
      "BETA INSTRUCTIONS",
    );
    expect((await rpc(multi, "skill_read", { name: "orc-sdlc", project: "Beta" })).text).toContain(
      "BETA INSTRUCTIONS",
    );
    expect((await rpc(multi, "skill_read", { name: "orc-platform" })).text).toContain(
      "# orc-platform",
    );
    expect((await rpc(multi, "memory_read", { name: "shared-note" })).text).toContain(
      "alpha memory content",
    );
    expect(
      (await rpc(multi, "memory_read", { name: "shared-note", project: "Beta" })).text,
    ).toContain("beta memory content");
  });

  test("should default creates to the first project and allow selection inside the connection", async () => {
    for (const args of [
      { title: "default target" },
      { title: "explicit target", project: "Beta" },
    ]) {
      const created = await rpc(multi, "task_create", args);
      expect(created.error).not.toBe(true);
      const row = getSqlite()
        .query<{ project_id: string }, [string]>("SELECT project_id FROM tasks WHERE title=?")
        .get(args.title);
      expect(row?.project_id).toBe(args.project ? "beta" : "alpha");
    }
    expect(
      (await rpc(multi, "task_create", { title: "outside target", project: "Gamma" })).error,
    ).toBe(true);
    expect((await rpc(multi, "context", { project_id: "gamma" })).error).toBe(true);
    expect((await rpc(multi, "task_get", { ids: ["task-gamma"] })).text).not.toContain(
      "needle task gamma",
    );
    expect((await rpc(multi, "task_update", { id: "task-gamma", progress: 50 })).error).toBe(true);
  });

  test("should search project knowledge plus global KBs and prevent scope-all/ID escapes", async () => {
    for (const meta of [false, true]) {
      for (const tool of ["kb_list", "kb_search", "kb_evidence"]) {
        const result = await rpc(
          multi,
          tool,
          tool === "kb_list" ? { scope: "all" } : { query: "needle", scope: "all" },
          meta,
        );
        expect(result.error).not.toBe(true);
        expect(result.text).toContain("alpha");
        expect(result.text).toContain("beta");
        expect(result.text).toContain("global");
        expect(result.text).not.toContain("gamma");
      }
      expect((await rpc(multi, "kb_read", { id: docs.beta }, meta)).error).not.toBe(true);
      expect((await rpc(multi, "kb_read", { id: docs.gamma }, meta)).error).toBe(true);
      expect((await rpc(multi, "kb_documents", { kb_id: kbs.gamma }, meta)).error).toBe(true);
    }
  });

  test("should validate every selected project and deduplicate case-insensitively", async () => {
    for (const query of [
      "?projects=Alpha,missing",
      "?projects=Alpha,",
      "?projects=",
      "?project=Alpha&projects=Beta",
      "?projects=Alpha&projects=Beta",
    ])
      expect((await rpc(query, "task_list")).status).toBe(query.includes("missing") ? 404 : 400);
    const result = await rpc("?projects=alpha,ALPHA,Beta", "skill_list", { source: "builtin" });
    expect(result.error).not.toBe(true);
    expect(result.text).toContain("total=2");
    const global = await rpc(multi, "skill_list", { scope: "global", source: "builtin" });
    expect(global.text).toContain("No skills found");
  });
});
