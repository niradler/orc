import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureWorkspaceEnvironment,
  extractPreviewUrl,
  findFreePortBlock,
  publicWorkspaceEnvironment,
  resolveWorkspaceEnvironment,
  storeWorkspaceEnvironment,
} from "../workspace-environment.js";
import {
  DEFAULT_WORKSPACE_PORT_BASE,
  defaultWorkspaceEnvironment,
  isWorktreePath,
  parseWorkspaceEnvironment,
  type WorkspaceEnvironmentStore,
  type WorkspaceRecord,
  workspacePortEnv,
  worktreeRoot,
} from "../workspace-settings.js";

let home: string;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "orc-workspace-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  process.env.HOME = saved.HOME;
  process.env.USERPROFILE = saved.USERPROFILE;
  rmSync(home, { recursive: true, force: true });
});

function record(path: string, base = 3100, count = 10): WorkspaceRecord {
  return {
    worktree_path: path,
    project_id: "project-1",
    repo_root: null,
    git_branch: null,
    host: null,
    setup_status: "pending",
    setup_output: null,
    setup_started_at: null,
    setup_ended_at: null,
    port_base: base,
    port_count: count,
    preview_url: null,
    dev_terminal_id: null,
    created_at: 0,
    updated_at: 0,
  };
}

function fakeStore(existing: WorkspaceRecord | null = null) {
  const records = new Map<string, WorkspaceRecord>();
  if (existing) records.set(existing.worktree_path, existing);
  const store: WorkspaceEnvironmentStore = {
    byPath: (path) => records.get(path) ?? null,
    create: (input) => {
      const created = {
        ...record(input.worktree_path, input.port_base, input.port_count),
        ...input,
      };
      records.set(created.worktree_path, created);
      return created;
    },
    setSetup: (input) => {
      const current = records.get(input.path);
      if (!current) return;
      records.set(input.path, {
        ...current,
        setup_status: input.status,
        setup_output: input.output ?? current.setup_output,
        setup_started_at: input.started ?? current.setup_started_at,
        setup_ended_at: input.ended ?? current.setup_ended_at,
      });
    },
    usedPorts: () =>
      [...records.values()].flatMap((item) => {
        const base = item.port_base;
        return base == null
          ? []
          : Array.from({ length: item.port_count ?? 0 }, (_, index) => base + index);
      }),
  };
  return { store, records };
}

const localHost = { kind: "local" as const };
const sshHost = {
  kind: "ssh" as const,
  alias: "dev-box",
  remotePort: 22,
  apiTarget: "",
  secret: undefined,
  connectTimeoutSecs: 10,
};

describe("workspace settings", () => {
  test("defaults are valid and parse accepts legacy or broken values", () => {
    const defaults = defaultWorkspaceEnvironment();
    expect(parseWorkspaceEnvironment(defaults)).toEqual(defaults);
    expect(parseWorkspaceEnvironment(JSON.stringify(defaults))).toEqual(defaults);
    expect(parseWorkspaceEnvironment(null)).toEqual(defaults);
    expect(parseWorkspaceEnvironment("not json")).toEqual(defaults);
    expect(parseWorkspaceEnvironment({ port_count: 0 })).toEqual(defaults);
  });

  test("masks secret values on read", () => {
    const stored = {
      ...defaultWorkspaceEnvironment(),
      env: [
        { name: "PLAIN", value: "visible", secret: false },
        { name: "TOKEN", value: "enc:v1:x:y:z", secret: true },
      ],
    };
    expect(publicWorkspaceEnvironment(stored).env).toEqual([
      { name: "PLAIN", value: "visible", secret: false },
      { name: "TOKEN", value: null, secret: true },
    ]);
  });

  test("stores secrets encrypted and keeps a saved one when the client sends null", () => {
    const stored = storeWorkspaceEnvironment({
      ...defaultWorkspaceEnvironment(),
      env: [
        { name: "TOKEN", value: "s3cret", secret: true },
        { name: "PLAIN", value: "visible", secret: false },
      ],
    });
    const token = stored.env.find((entry) => entry.name === "TOKEN");
    expect(token?.value?.startsWith("enc:v1:")).toBe(true);
    expect(token?.value).not.toContain("s3cret");
    const kept = storeWorkspaceEnvironment(
      {
        ...stored,
        env: [{ name: "TOKEN", value: null, secret: true }],
      },
      stored,
    );
    expect(kept.env[0]).toEqual(token);
    expect(resolveWorkspaceEnvironment(kept).env.TOKEN).toBe("s3cret");
    expect(() =>
      storeWorkspaceEnvironment({
        ...defaultWorkspaceEnvironment(),
        env: [{ name: "TOKEN", value: null, secret: true }],
      }),
    ).toThrow();
  });

  test("exports the whole port block", () => {
    expect(workspacePortEnv(3100, 3)).toEqual({
      PORT: "3100",
      ORC_PORT: "3100",
      ORC_PORT_END: "3102",
      ORC_PORT_COUNT: "3",
      ORC_PORT_1: "3100",
      ORC_PORT_2: "3101",
      ORC_PORT_3: "3102",
    });
  });

  test("recognizes managed worktrees", () => {
    expect(isWorktreePath("/repo/.orc/worktrees/feature")).toBe(true);
    expect(isWorktreePath("C:\\repo\\.claude\\worktrees\\feature")).toBe(true);
    expect(isWorktreePath("/repo")).toBe(false);
    expect(worktreeRoot("/repo/.orc/worktrees/feature")).toBe("/repo");
    expect(worktreeRoot("C:\\repo\\.codex\\worktrees\\feature\\")).toBe("C:\\repo");
    expect(worktreeRoot("/repo")).toBeNull();
  });
});

describe("workspace runtime", () => {
  test("allocates the first free block and skips recorded ports", async () => {
    expect(await findFreePortBlock({ start: 3100, count: 2, used: [] })).toBe(3100);
    expect(await findFreePortBlock({ start: 3100, count: 2, used: [3100] })).toBe(3102);
    expect(
      await findFreePortBlock({
        start: 3100,
        count: 2,
        used: [],
        isFree: (port) => port !== 3100 && port !== 3101,
      }),
    ).toBe(3102);
    await expect(findFreePortBlock({ start: 65535, count: 2, used: [] })).rejects.toThrow();
  });

  test("records a new workspace, runs no setup when none is configured, and reuses it", async () => {
    const { store, records } = fakeStore();
    const path = "/repo/.orc/worktrees/feature";
    const workspace = { ...defaultWorkspaceEnvironment(), port_count: 2, port_base: 3200 };
    const first = await ensureWorkspaceEnvironment({
      store,
      host: localHost,
      projectId: "project-1",
      path,
      repoRoot: "/repo",
      platform: "linux",
      workspace,
    });
    expect(first.port_base).toBe(3200);
    expect(first.setup_status).toBe("skipped");
    records.set(path, { ...first, preview_url: "http://localhost:3200" });
    const again = await ensureWorkspaceEnvironment({
      store,
      host: localHost,
      projectId: "project-1",
      path,
      repoRoot: "/repo",
      platform: "linux",
      workspace,
    });
    expect(again.preview_url).toBe("http://localhost:3200");
  });

  test("moves to the next block when a concurrent prepare took the first", async () => {
    const { store, records } = fakeStore();
    const path = "/repo/.orc/worktrees/race";
    const create = store.create;
    let attempts = 0;
    store.create = (input) => {
      attempts++;
      if (attempts === 1) {
        records.set("/repo/.orc/worktrees/other", record("/repo/.orc/worktrees/other", 3200, 2));
        throw new Error("UNIQUE constraint failed: workspace_environments.port_base");
      }
      return create(input);
    };
    const setup = await ensureWorkspaceEnvironment({
      store,
      host: localHost,
      projectId: "project-1",
      path,
      repoRoot: "/repo",
      platform: "linux",
      workspace: { ...defaultWorkspaceEnvironment(), port_count: 2, port_base: 3200 },
    });
    expect(attempts).toBe(2);
    expect(setup.port_base).toBe(3202);
  });

  test("skips socket probing for SSH hosts", async () => {
    const { store } = fakeStore();
    const first = await ensureWorkspaceEnvironment({
      store,
      host: sshHost,
      projectId: "project-1",
      path: "/repo/.orc/worktrees/one",
      repoRoot: "/repo",
      platform: "linux",
      workspace: { ...defaultWorkspaceEnvironment() },
    });
    expect(first.port_base).toBe(DEFAULT_WORKSPACE_PORT_BASE);
    expect(first.host).toBe("dev-box");
  });

  test("extracts the first printed preview URL", () => {
    expect(extractPreviewUrl("ready at \u001b[32mhttp://0.0.0.0:3100/\u001b[0m")).toBe(
      "http://localhost:3100",
    );
    expect(extractPreviewUrl("Local: http://localhost:5173/path.")).toBe(
      "http://localhost:5173/path",
    );
    expect(extractPreviewUrl("https://example.com:8443")).toBe("https://example.com:8443");
    expect(extractPreviewUrl("no url here")).toBeNull();
    expect(extractPreviewUrl("file:///tmp/index.html")).toBeNull();
  });
});
