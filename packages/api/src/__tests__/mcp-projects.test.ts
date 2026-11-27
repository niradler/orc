import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "@orc/core/config";
import { readSkill, type SkillRefContent } from "@orc/core/skill-service";
import { getDb, getSqlite } from "@orc/db/client";
import { MemoryStore } from "@orc/db/memories";
import { bridge_chats, gateway_sessions } from "@orc/db/schema";
import { SkillHistory } from "@orc/db/skill-history";
import { closeKnowledgeService, getKnowledgeService } from "@orc/knowledge";
import { setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof setupTestApp>;
let root: string;
let server: ReturnType<typeof Bun.serve>;
const oldRoot = process.env.ORC_KNOWLEDGE_ROOT;
const oldBase = process.env.ORC_API_BASE;
const kbs: Record<string, string> = {};
const docs: Record<string, string> = {};
const multi = "?projects=Alpha,Beta";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "orc-mcp-projects-"));
  process.env.ORC_KNOWLEDGE_ROOT = root;
  app = setupTestApp();
  // Project archive/delete go through the API so they share its guards; give
  // the in-process MCP tools a live fixture endpoint instead of the 404 probe.
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  process.env.ORC_API_BASE = `http://127.0.0.1:${server.port}`;
  resetConfig();
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
  await server.stop(true);
  if (oldBase === undefined) delete process.env.ORC_API_BASE;
  else process.env.ORC_API_BASE = oldBase;
  resetConfig();
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

  test("project_create is refused on a scoped connection and is retry-safe unscoped", async () => {
    for (const meta of [false, true]) {
      const scoped = await rpc(multi, "project_create", { name: "scoped-create" }, meta);
      expect(scoped.error).toBe(true);
      expect(scoped.text).toContain("unscoped connection");
    }
    const created = await rpc("", "project_create", { name: "unscoped-create" });
    expect(created.error).not.toBe(true);
    expect(created.text).toContain("Created project unscoped-create [id: ");
    expect(created.text).toContain("link: ");
    // A retry with different casing hits the same project and never duplicates it.
    const duplicate = await rpc("", "project_create", { name: "UNSCOPED-CREATE" });
    expect(duplicate.error).toBe(true);
    expect(duplicate.text).toContain("already exists");
    expect(duplicate.text).toContain("no duplicate was created");
    const count = getSqlite()
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM projects WHERE name = 'unscoped-create' COLLATE NOCASE",
      )
      .get()?.n;
    expect(count).toBe(1);
    const invalid = await rpc("", "project_create", { name: "has space" });
    expect(invalid.error).toBe(true);
    expect(invalid.text).toContain("Invalid args");
  });

  test("memory_list without a project lists every accessible project grouped", async () => {
    const all = await rpc("", "memory_list", {});
    expect(all.error).not.toBe(true);
    expect(all.text).toContain("[project: Alpha]");
    expect(all.text).toContain("[project: Beta]");
    expect(all.text).toContain("needle memory alpha");
    // Passing project still scopes the list to that project.
    const scoped = await rpc("", "memory_list", { project: "Alpha" });
    expect(scoped.error).not.toBe(true);
    expect(scoped.text).not.toContain("[project:");
    expect(scoped.text).not.toContain("needle memory beta");
    // An unknown project is rejected instead of silently listing everything.
    const unknown = await rpc("", "memory_list", { project: "No-Such-Project" });
    expect(unknown.error).toBe(true);
    expect(unknown.text).toContain("No-Such-Project");
  });

  test("project_archive hides a project, and project_delete refuses linked resources unless forced", async () => {
    const name = "archive-fixture";
    expect((await rpc("", "project_create", { name })).error).not.toBe(true);
    const project = () =>
      getSqlite()
        .query<{ id: string; status: string }, [string]>(
          "SELECT id, status FROM projects WHERE name=?",
        )
        .get(name);
    const id = project()?.id;
    expect(id).toBeDefined();
    const archived = await rpc("", "project_archive", { project: name });
    expect(archived.error).not.toBe(true);
    expect(archived.text).toContain("Archived project");
    expect(project()?.status).toBe("archived");
    const restored = await rpc("", "project_archive", { project: name, archived: false });
    expect(restored.text).toContain("Restored project");
    expect(project()?.status).toBe("active");

    new MemoryStore(getSqlite()).create({
      project_id: id as string,
      name: "keep-me",
      description: "Linked fixture memory",
      content: "not safe to drop silently",
    });
    const blocked = await rpc("", "project_delete", { project: name });
    expect(blocked.error).toBe(true);
    expect(blocked.text).toContain("1 memory");
    expect(blocked.text).toContain("project_archive");
    expect(project()).not.toBeNull();

    const forced = await rpc("", "project_delete", { project: name, force: true });
    expect(forced.error).not.toBe(true);
    expect(forced.text).toContain("Deleted project");
    expect(project()).toBeNull();
  });

  test("project_create stores its folder and maps existing sessions in it", async () => {
    const folder = join(root, "scoped-folder");
    mkdirSync(join(folder, "child"), { recursive: true });
    const now = new Date();
    await getDb()
      .insert(bridge_chats)
      .values({ id: "__live-sessions__", platform: "telegram", chat_id: "__live-sessions__" })
      .onConflictDoNothing();
    await getDb()
      .insert(gateway_sessions)
      .values({
        id: "mcp-scope-session",
        chat_id: "__live-sessions__",
        backend: "mapping-agent",
        mode: "direct",
        runtime_session_id: "mcp-scope-native",
        project_id: null,
        cwd: join(folder, "child"),
        status: "stopped",
        title: "Scope fixture",
        created_at: now,
        last_activity_at: now,
      });
    const created = await rpc("", "project_create", { name: "scoped-folder", scope: folder });
    expect(created.error).not.toBe(true);
    const project = getSqlite()
      .query<{ id: string; scope: string | null }, []>(
        "SELECT id, scope FROM projects WHERE name = 'scoped-folder'",
      )
      .get();
    expect(project?.scope).toBe(folder);
    const mapped = () =>
      getSqlite()
        .query<{ project_id: string | null }, []>(
          "SELECT project_id FROM gateway_sessions WHERE id = 'mcp-scope-session'",
        )
        .get()?.project_id;
    for (let i = 0; i < 50 && mapped() !== project?.id; i++) await Bun.sleep(20);
    expect(mapped()).toBe(project?.id ?? "missing");
  });
});
