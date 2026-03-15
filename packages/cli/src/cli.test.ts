import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createApp } from "@orc/api/server";
import { resetConfig } from "@orc/core/config";

const CLI = join(import.meta.dir, "index.ts");
const SECRET = "cli-test-secret";

let server: ReturnType<typeof Bun.serve>;
let port: number;

async function cli(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", CLI, "--port", String(port), "--secret", SECRET, ...args], {
    env: { ...process.env, ORC_API_PORT: String(port), ORC_API_SECRET: SECRET },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

beforeAll(() => {
  process.env.ORC_DB_PATH = ":memory:";
  process.env.ORC_API_SECRET = SECRET;
  resetConfig();
  const app = createApp();
  server = Bun.serve({ fetch: app.fetch, port: 0 });
  port = server.port ?? 0;
});

afterAll(() => {
  server.stop(true);
  delete process.env.ORC_DB_PATH;
  delete process.env.ORC_API_SECRET;
  resetConfig();
});

describe("CLI — task commands", () => {
  test("orc task add creates a task", async () => {
    const result = await cli(
      "task",
      "add",
      "CLI integration test task",
      "--priority",
      "high",
      "--no-project",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/CLI integration test task/i);
  });

  test("orc task list shows the created task", async () => {
    const result = await cli("task", "list", "--no-project");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/CLI integration test task/i);
  });

  test("orc task list --status todo filters correctly", async () => {
    const result = await cli("task", "list", "--status", "todo", "--no-project");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/CLI integration test task/i);
  });
});

describe("CLI — mem commands", () => {
  test("orc mem add stores a memory", async () => {
    const result = await cli(
      "mem",
      "add",
      "CLI memory test content",
      "--type",
      "fact",
      "--no-project",
    );
    expect(result.exitCode).toBe(0);
  });

  test("orc mem list shows the memory", async () => {
    const result = await cli("mem", "list", "--no-project");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/CLI memory test content/i);
  });

  test("orc mem search finds by keyword", async () => {
    const result = await cli("mem", "search", "CLI memory test", "--no-project");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/CLI memory test content/i);
  });
});
