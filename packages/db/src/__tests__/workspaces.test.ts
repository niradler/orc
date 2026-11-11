import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeDb, createTestDb, getSqlite } from "../client.js";
import {
  clearWorkspacePreview,
  createWorkspaceEnvironment,
  deleteProjectWorkspaceEnvironments,
  listWorkspaceEnvironments,
  setWorkspacePreview,
  setWorkspaceSetup,
  usedWorkspacePorts,
  workspaceEnvironmentByPath,
  workspaceEnvironmentStore,
} from "../workspaces.js";

let sqlite: Database;

beforeAll(() => {
  sqlite = getSqlite(createTestDb());
});

afterAll(() => {
  closeDb();
});

describe("workspace environments", () => {
  test("migrates the project workspace column", () => {
    const columns = sqlite
      .query<{ name: string }, []>("PRAGMA table_info(projects)")
      .all()
      .map((column) => column.name);
    expect(columns).toContain("workspace");
  });

  test("records ports, setup state and the preview URL", () => {
    const created = createWorkspaceEnvironment(sqlite, {
      worktree_path: "/repo/.orc/worktrees/one",
      project_id: "project-a",
      repo_root: "/repo",
      git_branch: "feat/one",
      host: null,
      port_base: 4100,
      port_count: 3,
    });
    expect(created.setup_status).toBe("pending");
    expect(created.port_base).toBe(4100);
    expect(created.port_count).toBe(3);
    expect(created.created_at).toBeGreaterThan(0);

    setWorkspaceSetup(sqlite, {
      path: created.worktree_path,
      status: "succeeded",
      output: "installed",
      started: 10,
      ended: 20,
    });
    setWorkspacePreview(sqlite, {
      path: created.worktree_path,
      url: "http://localhost:4100",
      terminalId: "terminal-1",
    });
    const stored = workspaceEnvironmentByPath(sqlite, created.worktree_path);
    expect(stored?.setup_status).toBe("succeeded");
    expect(stored?.setup_output).toBe("installed");
    expect(stored?.setup_started_at).toBe(10);
    expect(stored?.setup_ended_at).toBe(20);
    expect(stored?.preview_url).toBe("http://localhost:4100");
    expect(stored?.dev_terminal_id).toBe("terminal-1");

    clearWorkspacePreview(sqlite, { path: created.worktree_path, terminalId: "other" });
    expect(workspaceEnvironmentByPath(sqlite, created.worktree_path)?.preview_url).toBe(
      "http://localhost:4100",
    );
    clearWorkspacePreview(sqlite, { path: created.worktree_path, terminalId: "terminal-1" });
    expect(workspaceEnvironmentByPath(sqlite, created.worktree_path)?.preview_url).toBeNull();
  });

  test("lists by project and never reuses a port block", () => {
    createWorkspaceEnvironment(sqlite, {
      worktree_path: "/repo/.orc/worktrees/two",
      project_id: "project-a",
      repo_root: "/repo",
      git_branch: null,
      host: null,
      port_base: 4200,
      port_count: 2,
    });
    createWorkspaceEnvironment(sqlite, {
      worktree_path: "/repo/.orc/worktrees/other",
      project_id: "project-b",
      repo_root: "/repo",
      git_branch: null,
      host: null,
      port_base: 4300,
      port_count: 1,
    });
    expect(
      listWorkspaceEnvironments(sqlite, "project-a")
        .map((row) => row.worktree_path)
        .sort(),
    ).toEqual(["/repo/.orc/worktrees/one", "/repo/.orc/worktrees/two"]);
    expect(usedWorkspacePorts(sqlite)).toEqual(
      expect.arrayContaining([4100, 4101, 4102, 4200, 4201, 4300]),
    );
    expect(() =>
      createWorkspaceEnvironment(sqlite, {
        worktree_path: "/repo/.orc/worktrees/conflict",
        project_id: "project-c",
        repo_root: null,
        git_branch: null,
        host: null,
        port_base: 4300,
        port_count: 1,
      }),
    ).toThrow();
  });

  test("deletes a project's workspaces and exposes the runtime store", () => {
    deleteProjectWorkspaceEnvironments(sqlite, "project-b");
    expect(listWorkspaceEnvironments(sqlite, "project-b")).toEqual([]);
    const store = workspaceEnvironmentStore(sqlite);
    expect(store.byPath("/repo/.orc/worktrees/two")?.port_base).toBe(4200);
    expect(store.usedPorts()).toEqual(expect.arrayContaining([4100, 4200]));
  });
});
