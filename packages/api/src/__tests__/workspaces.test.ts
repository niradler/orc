import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getSqlite } from "@orc/db/client";
import { createWorkspaceEnvironment } from "@orc/db/workspaces";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  app = setupTestApp();
});

afterAll(() => {
  teardownTestApp();
});

const defaults = {
  setup_script: null,
  dev_script: null,
  setup_timeout_secs: 900,
  port_base: null,
  port_count: 10,
  env: [],
};

describe("project workspace environment", () => {
  test("defaults, round-trips and masks secret values", async () => {
    const created = await req(app, "POST", "/projects", {
      name: "workspace-settings",
      scope: "/tmp/workspace-settings",
    });
    expect(created.status).toBe(201);
    const project = await created.json();
    expect(project.workspace).toEqual(defaults);

    const workspace = {
      setup_script: "bun install",
      dev_script: "bun run dev --port $ORC_PORT",
      setup_timeout_secs: 120,
      port_base: 3200,
      port_count: 5,
      env: [
        { name: "PLAIN", value: "visible", secret: false },
        { name: "TOKEN", value: "s3cret", secret: true },
      ],
    };
    const updated = await req(app, "PATCH", `/projects/${project.id}`, { workspace });
    expect(updated.status).toBe(200);
    const saved = (await updated.json()).workspace;
    expect(saved.setup_script).toBe("bun install");
    expect(saved.dev_script).toBe("bun run dev --port $ORC_PORT");
    expect(saved.setup_timeout_secs).toBe(120);
    expect(saved.port_base).toBe(3200);
    expect(saved.port_count).toBe(5);
    expect(saved.env).toEqual([
      { name: "PLAIN", value: "visible", secret: false },
      { name: "TOKEN", value: null, secret: true },
    ]);

    const fetched = await (await req(app, "GET", `/projects/${project.id}`)).json();
    expect(fetched.workspace).toEqual(saved);

    const raw = getSqlite()
      .query<{ workspace: string }, [string]>("SELECT workspace FROM projects WHERE id = ?")
      .get(project.id);
    expect(JSON.parse(raw?.workspace ?? "{}").env[1].value).toMatch(/^enc:v1:/);

    const kept = await req(app, "PATCH", `/projects/${project.id}`, {
      workspace: { ...workspace, env: [{ name: "TOKEN", value: null, secret: true }] },
    });
    expect(kept.status).toBe(200);
    expect((await kept.json()).workspace.env).toEqual([
      { name: "TOKEN", value: null, secret: true },
    ]);

    const invalid = await req(app, "PATCH", `/projects/${project.id}`, {
      workspace: { ...workspace, port_base: 65530, port_count: 10 },
    });
    expect(invalid.status).toBe(400);
  });

  test("lists prepared workspaces and removes them with the project", async () => {
    const project = await (
      await req(app, "POST", "/projects", {
        name: "workspace-list",
        scope: "/tmp/workspace-list",
      })
    ).json();

    const empty = await (await req(app, "GET", `/workspaces?project_id=${project.id}`)).json();
    expect(empty.workspaces).toEqual([]);

    createWorkspaceEnvironment(getSqlite(), {
      worktree_path: "/tmp/workspace-list/.orc/worktrees/one",
      project_id: project.id,
      repo_root: "/tmp/workspace-list",
      git_branch: "feat/one",
      host: null,
      port_base: 3300,
      port_count: 2,
    });
    const listed = await (await req(app, "GET", `/workspaces?project_id=${project.id}`)).json();
    expect(listed.workspaces).toHaveLength(1);
    expect(listed.workspaces[0].worktree_path).toBe("/tmp/workspace-list/.orc/worktrees/one");
    expect(listed.workspaces[0].port_base).toBe(3300);
    expect(listed.workspaces[0].setup_status).toBe("pending");

    const byPath = await (
      await req(
        app,
        "GET",
        `/workspaces?path=${encodeURIComponent("/tmp/workspace-list/.orc/worktrees/one")}`,
      )
    ).json();
    expect(byPath.workspaces[0].git_branch).toBe("feat/one");

    const missing = await (
      await req(app, "GET", `/workspaces?path=${encodeURIComponent("/tmp/unknown")}`)
    ).json();
    expect(missing.workspaces).toEqual([]);

    expect((await req(app, "DELETE", `/projects/${project.id}`)).status).toBe(204);
    const afterDelete = await (
      await req(app, "GET", `/workspaces?project_id=${project.id}`)
    ).json();
    expect(afterDelete.workspaces).toEqual([]);
  });
});
