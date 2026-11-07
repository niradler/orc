import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("should add GitHub sync to a legacy database and preserve identity and config across reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orc-github-sync-"));
  const path = join(directory, "legacy.db");
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "__fixtures__", "github-sync-reopen.ts"), path],
    { stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill(), 30000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("Legacy migration and idempotent reopen passed");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
