import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareJobWorkspace } from "../job-workspace.js";

const repository = mkdtempSync(join(tmpdir(), "orc-job-worktree-"));
function git(args: string[], cwd = repository): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, timeout: 10000, windowsHide: true });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
beforeAll(() => {
  git(["init"]);
  git(["config", "user.name", "Job Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repository, ".gitignore"), ".orc/\nignored.txt\n");
  git(["add", ".gitignore"]);
  git(["commit", "-m", "Fixture"]);
});
afterAll(() => {
  rmSync(repository, { recursive: true, force: true });
});
test("should remove only a successful clean managed worktree with cleanup opted in", async () => {
  const workspace = await prepareJobWorkspace({ kind: "local" }, repository, "clean", {
    mode: "worktree",
    base_ref: "HEAD",
    cleanup_on_success: true,
  });
  expect(workspace.cwd).not.toBe(repository);
  expect(git(["rev-parse", "HEAD"], workspace.cwd)).toBe(git(["rev-parse", "HEAD"]));
  expect(await workspace.cleanup(true)).toContain("removed");
  expect(existsSync(workspace.cwd)).toBe(false);
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
