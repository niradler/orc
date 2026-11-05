import { cpSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    branch: { type: "string", default: "gh-pages" },
    remote: { type: "string", default: "origin" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(`Usage: bun run docs:deploy [--branch gh-pages] [--remote origin] [--dry-run]

Builds the docs site and commits it to the Pages branch without GitHub Actions.
Run it from a clean master checkout. --dry-run builds and commits locally but does not push.`);
  process.exit(0);
}

const root = join(import.meta.dir, "..");
const dist = join(root, "docs", ".vitepress", "dist");

function git(args: string[], cwd = root): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

if (git(["status", "--porcelain", "--", "docs"]))
  throw new Error("docs/ has uncommitted changes; commit them first");
const source = git(["rev-parse", "--short", "HEAD"]);

const build = Bun.spawnSync(["bun", "run", "docs:build"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (build.exitCode !== 0) throw new Error("docs:build failed");

const worktree = join(root, ".orc", "worktrees", "gh-pages-deploy");
if (existsSync(worktree)) git(["worktree", "remove", "--force", worktree]);
try {
  git(["fetch", values.remote, values.branch]);
} catch {}
const remoteBranch = `${values.remote}/${values.branch}`;
const hasRemote =
  Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", remoteBranch], { cwd: root })
    .exitCode === 0;
try {
  if (hasRemote) git(["worktree", "add", "-B", values.branch, worktree, remoteBranch]);
  else git(["worktree", "add", "--orphan", "-b", values.branch, worktree]);

  for (const entry of readdirSync(worktree))
    if (entry !== ".git") rmSync(join(worktree, entry), { recursive: true });
  cpSync(dist, worktree, { recursive: true });
  writeFileSync(join(worktree, ".nojekyll"), "");

  git(["add", "-A"], worktree);
  if (!git(["status", "--porcelain"], worktree)) {
    console.log("Pages branch already matches this build.");
  } else {
    git(["commit", "-m", `Deploy docs from ${source}`], worktree);
    if (values["dry-run"])
      console.log(`Committed to ${values.branch} locally (dry run, not pushed).`);
    else {
      git(["push", values.remote, values.branch], worktree);
      console.log(`Deployed docs from ${source} to ${values.remote}/${values.branch}.`);
    }
  }
} finally {
  if (existsSync(worktree)) git(["worktree", "remove", "--force", worktree]);
  rmSync(dist, { recursive: true, force: true });
}
