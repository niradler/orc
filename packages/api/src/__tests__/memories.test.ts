import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getSqlite } from "@orc/db/client";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
let projectId: string;
let otherProjectId: string;

beforeAll(async () => {
  app = setupTestApp();
  projectId = (await (await req(app, "POST", "/projects", { name: "mem-proj" })).json()).id;
  otherProjectId = (await (await req(app, "POST", "/projects", { name: "mem-other" })).json()).id;
});

afterAll(() => {
  teardownTestApp();
});

type Change = { id: string; action: string; reason: string | null; author: string };

const create = (body: Record<string, unknown>) =>
  req(app, "POST", "/memories", { project_id: projectId, ...body });

describe("Memories REST API", () => {
  test("should create a memory with defaults and the given fields", async () => {
    const res = await create({
      name: "api-port",
      description: "Which port the API listens on",
      content: "The API listens on 7700.",
      priority: 70,
      session_id: "native-1",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      project_id: projectId,
      name: "api-port",
      description: "Which port the API listens on",
      content: "The API listens on 7700.",
      priority: 70,
      author: "api",
      session_id: "native-1",
    });

    const minimal = await (
      await create({ name: "ulid-keys", description: "Primary keys", content: "Use ULIDs." })
    ).json();
    expect(minimal.priority).toBeNull();
    expect(minimal.session_id).toBeNull();
  });

  test("should reject a duplicate with 409", async () => {
    const res = await create({ name: "api-port", description: "again", content: "again" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("already exists");
  });

  test("should reject invalid input with 400 and tell over-cap content to become a skill", async () => {
    const overCap = await create({
      name: "too-long",
      description: "Too long",
      content: "x".repeat(801),
    });
    expect(overCap.status).toBe(400);
    expect((await overCap.json()).error).toContain("make it a skill");

    for (const body of [
      { name: "Bad Name", description: "d", content: "c" },
      { name: "no-content", description: "d", content: "" },
      { name: "bad-priority", description: "d", content: "c", priority: 101 },
      { name: "legacy", description: "d", content: "c", type: "fact" },
    ])
      expect((await create(body)).status).toBe(400);
    expect(
      (await req(app, "POST", "/memories", { name: "no-project", description: "d", content: "c" }))
        .status,
    ).toBe(400);
  });

  test("should count reads per X-Orc-Client source and rank by agent reads", async () => {
    const path = `/memories/ulid-keys?project_id=${projectId}`;
    const read = await req(app, "GET", path, undefined, { "X-Orc-Client": "cli" });
    expect(read.status).toBe(200);
    expect((await read.json()).content).toBe("Use ULIDs.");
    await req(app, "GET", path, undefined, { "X-Orc-Client": "cli" });
    await req(app, "GET", path);
    for (let i = 0; i < 5; i++)
      await req(app, "GET", `/memories/api-port?project_id=${projectId}`, undefined, {
        "X-Orc-Client": "ui",
      });

    const list = await (await req(app, "GET", `/memories?project_id=${projectId}`)).json();
    expect(list.total).toBe(2);
    expect(list.memories.map((m: { name: string }) => m.name)).toEqual(["ulid-keys", "api-port"]);
    const [ulid, port] = list.memories;
    expect(ulid).toMatchObject({
      key: `${projectId}/ulid-keys`,
      read_count: 3,
      reads_by_source: { mcp: 0, cli: 2, api: 1, ui: 0 },
    });
    expect(ulid.content).toBeUndefined();
    expect(port).toMatchObject({ read_count: 0, reads_by_source: { ui: 5 } });

    expect((await req(app, "GET", `/memories/missing-memory?project_id=${projectId}`)).status).toBe(
      404,
    );
  });

  test("should list by priority, search, limit and scope by project", async () => {
    await req(app, "POST", "/memories", {
      project_id: otherProjectId,
      name: "other-fact",
      description: "Belongs elsewhere",
      content: "x",
    });
    const byPriority = await (
      await req(app, "GET", `/memories?project_id=${projectId}&sort=priority`)
    ).json();
    expect(byPriority.memories[0].name).toBe("api-port");

    const searched = await (
      await req(app, "GET", `/memories?project_id=${projectId}&q=port`)
    ).json();
    expect(searched.memories.map((m: { name: string }) => m.name)).toEqual(["api-port"]);

    const limited = await (
      await req(app, "GET", `/memories?project_id=${projectId}&limit=1`)
    ).json();
    expect(limited.memories).toHaveLength(1);
    expect(limited.total).toBe(2);

    const all = await (await req(app, "GET", "/memories")).json();
    expect(all.memories.map((m: { key: string }) => m.key)).toContain(
      `${otherProjectId}/other-fact`,
    );
  });

  test("should update fields, clear priority and keep history", async () => {
    const res = await req(app, "PATCH", "/memories/api-port", {
      project_id: projectId,
      content: "The API listens on 7711 in dev.",
      priority: null,
      reason: "dev port",
      author: "tester",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      description: "Which port the API listens on",
      content: "The API listens on 7711 in dev.",
      priority: null,
      author: "tester",
    });
    expect(
      (
        await req(app, "PATCH", "/memories/missing-memory", {
          project_id: projectId,
          content: "x",
        })
      ).status,
    ).toBe(404);

    const { changes } = (await (
      await req(app, "GET", `/memories/api-port/history?project_id=${projectId}`)
    ).json()) as { changes: Change[] };
    expect(changes.map((c) => c.action)).toEqual(["memory.updated", "memory.created"]);
    expect(changes[0]).toMatchObject({ reason: "dev port", author: "tester" });
  });

  test("should delete with 204 and revert the deletion", async () => {
    const del = await req(
      app,
      "DELETE",
      `/memories/api-port?project_id=${projectId}&author=tester&session_id=native-2`,
    );
    expect(del.status).toBe(204);
    expect((await req(app, "GET", `/memories/api-port?project_id=${projectId}`)).status).toBe(404);
    expect((await req(app, "DELETE", `/memories/api-port?project_id=${projectId}`)).status).toBe(
      404,
    );

    const { changes } = (await (
      await req(app, "GET", `/memories/api-port/history?project_id=${projectId}`)
    ).json()) as { changes: Change[] };
    const [deleted, updated] = changes;
    expect(deleted?.action).toBe("memory.deleted");

    const stale = await req(app, "POST", "/memories/api-port/revert", {
      project_id: projectId,
      change_id: deleted?.id,
      expected_change_id: updated?.id,
      reason: "stale review",
    });
    expect(stale.status).toBe(409);

    const reverted = await req(app, "POST", "/memories/api-port/revert", {
      project_id: projectId,
      change_id: deleted?.id,
      expected_change_id: deleted?.id,
      reason: "deleted by mistake",
    });
    expect(reverted.status).toBe(200);
    expect((await reverted.json()).memory).toMatchObject({
      name: "api-port",
      content: "The API listens on 7711 in dev.",
    });

    const created = (
      (await (
        await req(app, "GET", `/memories/ulid-keys/history?project_id=${projectId}`)
      ).json()) as { changes: Change[] }
    ).changes[0];
    const undone = await req(app, "POST", "/memories/ulid-keys/revert", {
      project_id: projectId,
      change_id: created?.id,
      expected_change_id: created?.id,
      reason: "never needed",
    });
    expect(undone.status).toBe(200);
    expect((await undone.json()).memory).toBeNull();
  });

  test("should remove a project's memories, history and reads with the project", async () => {
    expect((await req(app, "DELETE", `/projects/${projectId}`)).status).toBe(204);
    const sqlite = getSqlite();
    for (const table of ["memories", "memory_changes", "memory_usage"])
      expect(
        sqlite
          .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id=?`)
          .get(projectId)?.n,
      ).toBe(0);
    const other = await (await req(app, "GET", `/memories?project_id=${otherProjectId}`)).json();
    expect(other.total).toBe(1);
  });
});
