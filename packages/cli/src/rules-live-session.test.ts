import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeRegistration } from "@orc/core/live-session";

const home = mkdtempSync(join(tmpdir(), "orc-cli-live-session-"));
const database = join(home, "orc.db");
const registry = join(home, ".orc", "live-sessions");
const cli = resolve(import.meta.dir, "index.ts");

afterAll(() => rmSync(home, { recursive: true, force: true }));

async function hook(event: string, payload: Record<string, unknown>) {
  const proc = Bun.spawn({
    cmd: [process.execPath, cli, "--db", database, "rules", "hook", "claude", event],
    cwd: home,
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      ORC_DB_PATH: database,
      ORC_RULES_ENABLED: "true",
    },
    timeout: 30000,
    windowsHide: true,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

test("the native hook updates the live-session registry from the hook payload", async () => {
  const now = Date.now();
  writeRegistration(
    {
      backend: "claude",
      externalId: "wired",
      pid: process.pid,
      title: "Wired session",
      status: "idle",
      createdAt: now,
      updatedAt: now,
    },
    registry,
  );
  const result = await hook("PermissionRequest", { session_id: "wired", cwd: home });
  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe("{}");
  const record = JSON.parse(readFileSync(join(registry, "claude-wired.json"), "utf8"));
  expect(record.waiting).toBe(true);
});

test("a live-session failure cannot corrupt the rule hook protocol", async () => {
  const oversized = await hook("SessionStart", {
    session_id: "wired",
    cwd: home,
    notification_type: "x".repeat(200),
  });
  expect(oversized.code).toBe(0);
  expect(oversized.stdout.trim()).toBe("{}");
  const malformed = await hook("SessionStart", {});
  expect(malformed.code).toBe(2);
});
