import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, createTestDb, getSqlite } from "@orc/db/client";
import { workspaceEnvironmentByPath } from "@orc/db/workspaces";
import { prepareJobWorkspace } from "../job-workspace.js";
import { setWorkspacePortProber, workspaceEnvFor } from "../workspace-env.js";

const repository = mkdtempSync(join(tmpdir(), "orc-job-worktree-"));
function git(args: string[], cwd = repository): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, timeout: 10000, windowsHide: true });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
beforeAll(() => {
  // Exact-port assertions must not depend on host port availability: Windows
  // can hold wide ranges under gate load, moving the allocator off its base.
  setWorkspacePortProber(() => true);
  git(["init"]);
  git(["config", "user.name", "Job Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repository, ".gitignore"), ".orc/\nignored.txt\n");
  git(["add", ".gitignore"]);
  git(["commit", "-m", "Fixture"]);
});
afterAll(() => {
  setWorkspacePortProber(null);
  closeDb();
  rmSync(repository, { recursive: true, force: true });
});
function project(id: string, workspace: Record<string, unknown>): void {
  getSqlite()
    .query("INSERT INTO projects(id,name,scope,workspace) VALUES(?,?,?,?)")
    .run(
      id,
      id,
      repository,
      JSON.stringify({
        setup_script: null,
        dev_script: null,
        setup_timeout_secs: 900,
        port_base: null,
        port_count: 10,
        env: [],
        ...workspace,
      }),
    );
}
test("should remove only a successful clean managed worktree with cleanup opted in", async () => {
  createTestDb();
  project("job-ports", { port_base: 43000, port_count: 2 });
  const workspace = await prepareJobWorkspace({ kind: "local" }, repository, "clean", {
    mode: "worktree",
    base_ref: "HEAD",
    cleanup_on_success: true,
  });
  expect(workspace.cwd).not.toBe(repository);
  expect(git(["rev-parse", "HEAD"], workspace.cwd)).toBe(git(["rev-parse", "HEAD"]));
  expect((await workspaceEnvFor({ kind: "local" }, workspace.cwd, "job-ports")).env.PORT).toBe(
    "43000",
  );
  expect(workspaceEnvironmentByPath(getSqlite(), workspace.cwd)?.port_base).toBe(43000);
  expect(await workspace.cleanup(true)).toContain("removed");
  expect(existsSync(workspace.cwd)).toBe(false);
  expect(workspaceEnvironmentByPath(getSqlite(), workspace.cwd)).toBeNull();
});
test("should inject ports only for a configured project and key a worktree subfolder on its worktree", async () => {
  createTestDb();
  project("plain", { env: [{ name: "ONLY", value: "1", secret: false }] });
  project("ports", { port_base: 44000, port_count: 2 });
  const worktree = join(repository, ".orc", "worktrees", "runner-sub");
  const sub = join(worktree, "src");
  mkdirSync(sub, { recursive: true });
  const plain = await workspaceEnvFor({ kind: "local" }, sub, "plain");
  expect(plain.env).toEqual({ ONLY: "1" });
  expect(plain.setup).toBeNull();
  const ports = await workspaceEnvFor({ kind: "local" }, sub, "ports");
  expect(ports.env.PORT).toBe("44000");
  expect(ports.env.ORC_WORKTREE).toBe(worktree);
  expect(ports.setup?.worktree_path).toBe(worktree);
  expect(workspaceEnvironmentByPath(getSqlite(), sub)).toBeNull();
  rmSync(worktree, { recursive: true, force: true });
});
test("should preserve failed, opted-out, dirty, ignored-file and newly committed worktrees", async () => {
  for (const scenario of ["failed", "opted-out", "dirty", "ignored", "commit"]) {
    const workspace = await prepareJobWorkspace({ kind: "local" }, repository, scenario, {
      mode: "worktree",
      base_ref: "HEAD",
      cleanup_on_success: scenario !== "opted-out",
    });
    if (["dirty", "commit"].includes(scenario))
      writeFileSync(join(workspace.cwd, "output.txt"), "result");
    if (scenario === "ignored") writeFileSync(join(workspace.cwd, "ignored.txt"), "result");
    if (scenario === "commit") {
      git(["add", "output.txt"], workspace.cwd);
      git(["commit", "-m", "Job result"], workspace.cwd);
    }
    expect(await workspace.cleanup(scenario !== "failed")).toContain("retained");
    expect(existsSync(workspace.cwd)).toBe(true);
  }
});
