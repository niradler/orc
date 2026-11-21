import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "@orc/core/config";
import { getSqlite } from "@orc/db/client";
import { workspaceEnvironmentByPath } from "@orc/db/workspaces";
import type { createApp } from "../server.js";
import { TerminalManager } from "../terminals/manager.js";
import { getTerminalManager, setTerminalManager } from "../terminals/service.js";
import type { PtyHandle, SpawnOptions } from "../terminals/spawn.js";
import { setWorkspacePortProber } from "../workspaces/service.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orc-workspace-launch-")));
const spawned: SpawnOptions[] = [];
let app: ReturnType<typeof createApp>;

function pty(options: SpawnOptions): PtyHandle {
  spawned.push(options);
  return {
    pid: 1,
    exited: new Promise(() => {}),
    write: () => {},
    resize: () => {},
    kill: () => {},
  };
}

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { timeout: 10000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

async function project(name: string, workspace: Record<string, unknown> | null) {
  const scope = join(root, name);
  mkdirSync(scope, { recursive: true });
  const res = await req(app, "POST", "/projects", {
    name,
    scope,
    ...(workspace
      ? {
          workspace: {
            setup_script: null,
            dev_script: null,
            setup_timeout_secs: 900,
            port_base: null,
            port_count: 10,
            env: [],
            ...workspace,
          },
        }
      : {}),
  });
  expect(res.status).toBe(201);
  return { id: (await res.json()).id as string, scope };
}

async function shell(cwd: string) {
  const res = await req(app, "POST", "/terminals", { kind: "shell", cwd });
  return {
    status: res.status,
    id: res.status === 201 ? ((await res.json()).id as string) : null,
    env: spawned.at(-1)?.env ?? {},
  };
}

beforeAll(() => {
  process.env.ORC_TERMINALS_ENABLED = "1";
  // The boundary blocks sit at the top of the OS ephemeral range, where the
  // suite's own sockets land; probe deterministically instead of the live host.
  setWorkspacePortProber(() => true);
  app = setupTestApp();
  setTerminalManager(
    new TerminalManager({
      spawn: (_argv, options) => pty(options),
      env: { PATH: process.env.PATH ?? "/bin" },
      max: 50,
      scrollbackBytes: 1024,
    }),
  );
});

afterAll(() => {
  getTerminalManager().shutdown();
  setTerminalManager(null);
  setWorkspacePortProber(null);
  delete process.env.ORC_TERMINALS_ENABLED;
  teardownTestApp();
  resetConfig();
  rmSync(root, { recursive: true, force: true });
});

describe("workspace launch environment", () => {
  test("a project without a workspace environment gets no port variables", async () => {
    const plain = await project("plain", { env: [{ name: "ONLY", value: "1", secret: false }] });
    const terminal = await shell(plain.scope);
    expect(terminal.status).toBe(201);
    expect(terminal.env.ONLY).toBe("1");
    expect(terminal.env.PORT).toBeUndefined();
    expect(terminal.env.ORC_PORT).toBeUndefined();
    expect(workspaceEnvironmentByPath(getSqlite(), plain.scope)).toBeNull();

    const configured = await project("configured", { dev_script: "bun run dev" });
    expect((await shell(configured.scope)).env.PORT).toMatch(/^\d+$/);
  });

  test("a worktree subfolder shares its worktree's record and ports", async () => {
    const { scope } = await project("subfolder", { port_base: 41000, port_count: 2 });
    git(scope, ["init", "-q"]);
    git(scope, [
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "user.name=Test",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "Seed",
    ]);
    const worktree = join(scope, ".orc", "worktrees", "one");
    git(scope, ["worktree", "add", "-q", "--detach", worktree]);
    const sub = join(worktree, "packages", "web");
    mkdirSync(sub, { recursive: true });

    const fromSub = await shell(sub);
    const fromRoot = await shell(worktree);
    expect(fromSub.env.PORT).toBe("41000");
    expect(fromRoot.env.PORT).toBe("41000");
    expect(fromSub.env.ORC_WORKTREE).toBe(worktree);
    expect(workspaceEnvironmentByPath(getSqlite(), sub)).toBeNull();
    expect(workspaceEnvironmentByPath(getSqlite(), worktree)?.port_base).toBe(41000);
    const bySub = await req(app, "GET", `/workspaces?path=${encodeURIComponent(sub)}`);
    expect(
      (await bySub.json()).workspaces.map((row: { worktree_path: string }) => row.worktree_path),
    ).toEqual([worktree]);
    for (const terminal of [fromSub, fromRoot])
      await req(app, "DELETE", `/terminals/${terminal.id}`);

    const removed = await req(app, "POST", "/git/worktrees/remove", {
      cwd: scope,
      path: `${worktree}/`,
      force: true,
    });
    expect(removed.status).toBe(204);
    expect(workspaceEnvironmentByPath(getSqlite(), worktree)).toBeNull();
  });

  test("a deleted worktree's port block is reclaimed instead of exhausting the range", async () => {
    const { scope } = await project("exhaust", { port_base: 65526, port_count: 10 });
    const first = join(scope, ".orc", "worktrees", "first");
    const second = join(scope, ".orc", "worktrees", "second");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });

    expect((await shell(first)).env.PORT).toBe("65526");
    rmSync(first, { recursive: true, force: true });

    const next = await shell(second);
    expect(next.status).toBe(201);
    expect(next.env.PORT).toBe("65526");
    expect(workspaceEnvironmentByPath(getSqlite(), first)).toBeNull();
  });

  test("a launch with no free port block starts without ports and says why", async () => {
    const { scope } = await project("full", { port_base: 65526, port_count: 10 });
    const first = join(scope, ".orc", "worktrees", "first");
    const second = join(scope, ".orc", "worktrees", "second");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    getSqlite().query("DELETE FROM workspace_environments WHERE port_base >= 65526").run();
    expect((await shell(first)).env.PORT).toBe("65526");

    const blocked = await shell(second);
    expect(blocked.status).toBe(201);
    expect(blocked.env.PORT).toBeUndefined();
    let shown = "";
    getTerminalManager().attach(blocked.id as string, {
      output: (data) => {
        shown += new TextDecoder().decode(data);
      },
      exit: () => {},
    })();
    expect(shown).toContain("Workspace ports are unavailable: No free 10-port block above 65526");
  });
});
