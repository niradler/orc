import { resolve } from "node:path";

const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
);

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: gitEnv,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "Git check failed");
  return result.stdout.toString().trim();
}

export function validatePush(root: string, records: string): boolean {
  const commits: string[] = [];
  for (const line of records.split("\n").filter((line) => line.trim())) {
    const fields = line.trim().split(/\s+/);
    const local = fields[1];
    const remote = fields[3];
    const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
    if (fields.length !== 4 || !local || !remote || !objectId.test(local) || !objectId.test(remote))
      throw new Error("Invalid pre-push ref input");
    if (!/^0+$/.test(local)) commits.push(local);
  }
  if (commits.length === 0) return false;
  const head = git(root, ["rev-parse", "HEAD"]);
  for (const commit of commits) {
    if (git(root, ["rev-parse", `${commit}^{commit}`]) !== head)
      throw new Error(
        "Push each ref from a checkout of its commit so the hook tests the pushed code",
      );
  }
  if (git(root, ["status", "--porcelain=v1", "--untracked-files=normal"]))
    throw new Error("Pre-push tests require a clean checkout, including untracked files");
  return true;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const records = await Bun.stdin.text();
  try {
    if (validatePush(root, records)) {
      const result = Bun.spawnSync(["bun", "run", "ci:pr"], {
        cwd: root,
        env: gitEnv,
        timeout: 45 * 60_000,
        stdout: "inherit",
        stderr: "inherit",
        stdin: "ignore",
      });
      if (result.exitCode !== 0) process.exit(result.exitCode || 1);
      validatePush(root, records);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Pre-push validation failed");
    process.exit(1);
  }
}
