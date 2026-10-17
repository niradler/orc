import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetConfig } from "@orc/core/config";
import { closeDb, createTestDb, getDb, getSqlite } from "@orc/db/client";
import { MemoryStore } from "@orc/db/memories";
import { projects, sessions, tasks } from "@orc/db/schema";
import { executeTool } from "../tools.js";

const originalActiveProject = process.env.ORC_ACTIVE_PROJECT;

beforeAll(async () => {
  process.env.ORC_DB_PATH = ":memory:";
  process.env.ORC_ACTIVE_PROJECT = "";
  resetConfig();
  const db = createTestDb();
  await db.insert(projects).values([
    { id: "mem-a", name: "mem-a" },
    { id: "mem-b", name: "mem-b" },
    { id: "scope-a", name: "scope-a" },
  ]);
});

afterAll(() => {
  closeDb();
  delete process.env.ORC_DB_PATH;
  if (originalActiveProject === undefined) delete process.env.ORC_ACTIVE_PROJECT;
  else process.env.ORC_ACTIVE_PROJECT = originalActiveProject;
  resetConfig();
});

const store = () => new MemoryStore(getSqlite());

describe("MCP memory tools", () => {
  test("should require a project", async () => {
    await expect(executeTool("memory_list", {})).rejects.toThrow("Memories belong to a project");
    await expect(
      executeTool("memory_create", { name: "no-project", description: "d", content: "c" }),
    ).rejects.toThrow("Memories belong to a project");
  });

  test("should create, read and list a memory, counting mcp reads", async () => {
    expect(
      await executeTool("memory_create", {
        name: "api-port",
        description: "Which port the API listens on",
        content: "The API listens on 7700 by default.",
        priority: 80,
        project: "mem-a",
      }),
    ).toBe("Created memory api-port");

    const read = await executeTool("memory_read", { name: "api-port", project: "mem-a" });
    expect(read).toBe(
      "# api-port (priority 80)\nWhich port the API listens on\n\nThe API listens on 7700 by default.",
    );
    await executeTool("memory_read", { name: "api-port", project: "mem-a" });

    const [item] = store().list("mem-a");
    expect(item?.reads_by_source).toEqual({ mcp: 2, cli: 0, api: 0, ui: 0 });

    const listing = await executeTool("memory_list", { project: "mem-a" });
    expect(listing).toContain("api-port");
    expect(listing).toContain("[p80] (2 reads) - Which port the API listens on");
    expect(await executeTool("memory_list", { project: "mem-b" })).toBe("No memories found.");
  });

  test("should reject a duplicate name and a missing memory", async () => {
    await expect(
      executeTool("memory_create", {
        name: "api-port",
        description: "again",
        content: "again",
        project: "mem-a",
      }),
    ).rejects.toThrow("already exists");
    await expect(
      executeTool("memory_read", { name: "missing-memory", project: "mem-a" }),
    ).rejects.toThrow("not found");
  });

  test("should tell the caller to make over-cap content a skill", async () => {
    await expect(
      executeTool("memory_create", {
        name: "too-long",
        description: "Too long for a memory",
        content: "x".repeat(801),
        project: "mem-a",
      }),
    ).rejects.toThrow("make it a skill");
    expect(
      store()
        .list("mem-a")
        .map((m) => m.name),
    ).not.toContain("too-long");
  });

  test("should update, delete and revert with history", async () => {
    expect(
      await executeTool("memory_update", {
        name: "api-port",
        content: "The API listens on 7711 in dev.",
        priority: null,
        reason: "dev port changed",
        project: "mem-a",
      }),
    ).toBe("Updated memory api-port");
    const updated = store().get("mem-a", "api-port");
    expect(updated.content).toBe("The API listens on 7711 in dev.");
    expect(updated.description).toBe("Which port the API listens on");
    expect(updated.priority).toBeNull();

    expect(await executeTool("memory_delete", { name: "api-port", project: "mem-a" })).toContain(
      "Deleted memory api-port",
    );
    expect(() => store().get("mem-a", "api-port")).toThrow("not found");

    const { changes } = JSON.parse(
      await executeTool("memory_history", { name: "api-port", project: "mem-a" }),
    ) as { changes: { id: string; action: string; reason: string | null }[] };
    expect(changes.map((c) => c.action)).toEqual([
      "memory.deleted",
      "memory.updated",
      "memory.created",
    ]);
    expect(changes[1]?.reason).toBe("dev port changed");

    const [deleted] = changes;
    expect(
      await executeTool("memory_revert", {
        name: "api-port",
        change_id: deleted?.id,
        expected_change_id: deleted?.id,
        reason: "deleted by mistake",
        project: "mem-a",
      }),
    ).toBe("Reverted memory api-port");
    expect(store().get("mem-a", "api-port").content).toBe("The API listens on 7711 in dev.");

    await expect(
      executeTool("memory_revert", {
        name: "api-port",
        change_id: deleted?.id,
        expected_change_id: deleted?.id,
        reason: "stale",
        project: "mem-a",
      }),
    ).rejects.toThrow("Memory changed since review");
  });

  test("should record the agent session id and list its memories in session_log", async () => {
    await executeTool(
      "memory_create",
      {
        name: "session-fact",
        description: "Written during a known session",
        content: "fact",
        project: "mem-b",
      },
      { agentSessionId: "native-session-1" },
    );
    await executeTool(
      "memory_update",
      { name: "session-fact", content: "fact v2", project: "mem-b" },
      { agentSessionId: "native-session-1" },
    );
    await executeTool(
      "memory_create",
      { name: "other-fact", description: "Other session", content: "x", project: "mem-b" },
      { agentSessionId: "native-session-2" },
    );
    expect(store().get("mem-b", "session-fact").session_id).toBe("native-session-1");

    const logged = await executeTool("session_log", {
      agent: "test",
      summary: "Did work",
      session_id: "native-session-1",
      project: "mem-b",
    });
    expect(logged).toMatch(/^Session logged:/);
    const row = getSqlite()
      .query<{ summary: string }, []>(
        "SELECT summary FROM sessions WHERE summary LIKE 'Did work%' LIMIT 1",
      )
      .get();
    expect(row?.summary).toContain("Memories: session-fact");
    expect(row?.summary).not.toContain("other-fact");
  });
});

describe("Memory context and search", () => {
  test("should list memories in context by priority", async () => {
    for (const [name, priority] of [
      ["low-priority", 10],
      ["unscored", null],
      ["high-priority", 90],
    ] as const)
      store().create({
        project_id: "scope-a",
        name,
        description: `${name} description`,
        content: "content",
        priority,
      });
    const context = await executeTool("context", { project: "scope-a" });
    const section = context.split("## Memories")[1] ?? "";
    expect(section).toContain("high-priority [p90] - high-priority description");
    expect(section).toContain("unscored - unscored description");
    const order = ["high-priority", "low-priority", "unscored"].map((n) => section.indexOf(n));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(await executeTool("context", { project: "mem-b" })).not.toContain("high-priority");
  });

  test("should scope context by explicit ID or null without inheriting a project name", async () => {
    await getDb()
      .insert(tasks)
      .values([
        { id: "scope-task-a", title: "Assigned scoped task", project_id: "scope-a" },
        { id: "scope-task-none", title: "Unassigned scoped task" },
      ]);
    await getDb()
      .insert(sessions)
      .values([
        { id: "scope-session-none", agent: "test", summary: "Unassigned session summary" },
        {
          id: "scope-session-a",
          agent: "test",
          project_id: "scope-a",
          summary: "Assigned session summary",
        },
      ]);
    const assigned = await executeTool("context", {
      project: "missing-default-project",
      project_id: "scope-a",
    });
    expect(assigned).toContain("Assigned scoped task");
    expect(assigned).toContain("high-priority");
    expect(assigned).toContain("Assigned session summary");
    expect(assigned).not.toContain("Unassigned");

    const unassigned = await executeTool("context", { project: "mem-a", project_id: null });
    expect(unassigned).toContain("Unassigned scoped task");
    expect(unassigned).toContain("## Memories\n  (none)");
    expect(unassigned).toContain("Unassigned session summary");
    expect(unassigned).not.toContain("Assigned scoped");

    await expect(executeTool("context", { project_id: "missing-id" })).rejects.toThrow(
      "Project not found",
    );
    await expect(executeTool("context", { project: "missing-project" })).rejects.toThrow(
      "Project not found",
    );
  });

  test("should omit memories a wiki page cites from unified search", async () => {
    for (const name of ["deploy-cited", "deploy-loose"])
      store().create({
        project_id: "mem-a",
        name,
        description: `zebradeploy note ${name}`,
        content: "content",
      });
    const before = await executeTool("search", {
      query: "zebradeploy",
      resources: ["memories"],
      project: "mem-a",
    });
    expect(before).toContain("[memory] deploy-cited (project: mem-a)");
    expect(before).toContain("[memory] deploy-loose (project: mem-a)");

    await executeTool("wiki_write", {
      project: "mem-a",
      slug: "deploy-guide",
      kind: "procedure",
      title: "Deploy guide",
      summary: "How deploys work",
      content: "Compiled from memory.",
      sources: ["memory:deploy-cited"],
      note: "compile",
      expected_revision: 0,
    });
    const after = await executeTool("search", {
      query: "zebradeploy",
      resources: ["memories"],
      project: "mem-a",
    });
    expect(after).not.toContain("deploy-cited");
    expect(after).toContain("[memory] deploy-loose (project: mem-a)");
  });
});
