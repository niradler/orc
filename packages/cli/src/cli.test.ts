import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    timeout: 15000,
    env: {
      ...process.env,
      ORC_API_PORT: String(port),
      ORC_API_SECRET: SECRET,
    },
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
  server = Bun.serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  port = server.port ?? 0;
});

afterAll(() => {
  server.stop(true);
  delete process.env.ORC_DB_PATH;
  delete process.env.ORC_API_SECRET;
  resetConfig();
});

describe("CLI - job run --wait", () => {
  test("waits for the run, returns JSON output as result and fails on a failed run", async () => {
    const add = (name: string, command: string) =>
      cli("--json", "job", "add", name, "--command", command, "--no-project");
    expect((await add("cli-wait-json", `echo '{"answer":42}'`)).exitCode).toBe(0);
    const json = await cli("--json", "job", "run", "cli-wait-json", "--wait");
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ status: "success", result: { answer: 42 } });

    const text = await cli("job", "run", "cli-wait-json", "--wait");
    expect(text.stdout.trim()).toBe('{"answer":42}');

    expect((await add("cli-wait-fail", "echo nope >&2; exit 4")).exitCode).toBe(0);
    const failed = await cli("job", "run", "cli-wait-fail", "--wait");
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("nope");
    expect(failed.stderr).toContain("failed (exit 4)");
  });
});

describe("CLI - optional project Git remote", () => {
  test("should create, show, update and explicitly clear the remote URL", async () => {
    const name = "cli-git-remote-project";
    const created = await cli(
      "--json",
      "project",
      "add",
      name,
      "--git-remote-url",
      "https://github.com/acme/project.git",
    );
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout).git_remote_url).toBe("https://github.com/acme/project.git");
    const updated = await cli(
      "--json",
      "project",
      "update",
      name,
      "--git-remote-url",
      "git@github.com:acme/project.git",
    );
    expect(updated.exitCode).toBe(0);
    expect(JSON.parse(updated.stdout).git_remote_url).toBe("git@github.com:acme/project.git");
    const shown = await cli("project", "show", name);
    expect(shown.stdout).toContain("Git remote: git@github.com:acme/project.git");
    const conflict = await cli(
      "project",
      "update",
      name,
      "--git-remote-url",
      "https://github.com/acme/project.git",
      "--clear-git-remote-url",
    );
    expect(conflict.exitCode).toBe(1);
    const cleared = await cli("--json", "project", "update", name, "--clear-git-remote-url");
    expect(cleared.exitCode).toBe(0);
    expect(JSON.parse(cleared.stdout).git_remote_url).toBeNull();
    const reopened = await cli("--json", "project", "show", name);
    expect(JSON.parse(reopened.stdout).project.git_remote_url).toBeNull();
  });
});

describe("CLI - task commands", () => {
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

describe("CLI - task comments", () => {
  let taskId = "";

  test("orc task add gives us a task to comment on", async () => {
    const result = await cli("--json", "task", "add", "Commentable task", "--no-project");
    expect(result.exitCode).toBe(0);
    taskId = JSON.parse(result.stdout).id;
    expect(taskId).toBeTruthy();
  });

  test("orc task comment adds a comment", async () => {
    const result = await cli(
      "task",
      "comment",
      taskId,
      "root cause: stale claim",
      "--author",
      "claude",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/claude/);
  });

  test("orc task show renders the comment", async () => {
    const result = await cli("task", "show", taskId);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Comments \(1\)/);
    expect(result.stdout).toMatch(/root cause: stale claim/);
  });

  test("orc task show --no-comments hides them", async () => {
    const result = await cli("task", "show", taskId, "--no-comments");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toMatch(/root cause: stale claim/);
  });

  test("orc --json task show carries comments for an agent", async () => {
    const result = await cli("--json", "task", "show", taskId);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0].content).toBe("root cause: stale claim");
    expect(payload.comments[0].author).toBe("claude");
  });
});

describe("CLI - status", () => {
  test("orc status reports whether the agent loop is live", async () => {
    const result = await cli("status");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/agent loop\s+[●○]\s+(on|off)/);
  });
});

describe("CLI - mem commands", () => {
  const P = ["-p", "cli-mem-test"];
  const mem = (...args: string[]) => cli("mem", ...args, ...P);

  beforeAll(async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ name: "cli-mem-test" }),
    });
    expect(res.status).toBe(201);
  });

  test("orc mem add stores a memory by name", async () => {
    const result = await mem(
      "add",
      "api-port",
      "--description",
      "Port the API listens on",
      "--content",
      "The API listens on 7700",
      "--priority",
      "80",
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Created memory api-port in cli-mem-test/);
  });

  test("orc mem add rejects a duplicate name", async () => {
    const result = await mem("add", "api-port", "-d", "dup", "-c", "dup");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Error:/);
  });

  test("orc mem list shows name, priority and description", async () => {
    const result = await mem("list", "--sort", "priority");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/api-port\s+p80\s+Port the API listens on/);
  });

  test("orc mem list --q filters by name and description", async () => {
    const hit = await mem("list", "--q", "listens");
    expect(hit.stdout).toMatch(/api-port/);
    const miss = await mem("list", "--q", "zzz-nothing");
    expect(miss.stdout).toMatch(/No memories found/);
  });

  test("orc mem show reads by name", async () => {
    const result = await mem("show", "api-port");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/The API listens on 7700/);
  });

  test("orc mem edit updates content and clears priority with none", async () => {
    const result = await cli(
      "--json",
      "mem",
      "edit",
      "api-port",
      "--content",
      "The API listens on 7711",
      "--priority",
      "none",
      "--reason",
      "port moved",
      ...P,
    );
    expect(result.exitCode).toBe(0);
    const updated = JSON.parse(result.stdout);
    expect(updated.content).toBe("The API listens on 7711");
    expect(updated.priority).toBeNull();
    expect(updated.author).toBe("cli");
  });

  test("orc mem edit rejects a bad priority before calling the API", async () => {
    const result = await mem("edit", "api-port", "--priority", "101");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/priority must be an integer 0-100/);
  });

  test("orc mem history lists changes newest first with the reason", async () => {
    const result = await cli("--json", "mem", "history", "api-port", ...P);
    expect(result.exitCode).toBe(0);
    const { changes } = JSON.parse(result.stdout);
    expect(changes.map((c: { action: string }) => c.action)).toEqual([
      "memory.updated",
      "memory.created",
    ]);
    expect(changes[0].reason).toBe("port moved");
  });

  test("orc mem history prints change times in the current year", async () => {
    const result = await mem("history", "api-port");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(` ${new Date().getUTCFullYear()}-`);
  });

  test("orc mem revert restores the state before a change", async () => {
    const history = JSON.parse((await cli("--json", "mem", "history", "api-port", ...P)).stdout);
    const latest = history.changes[0].id;
    const result = await mem(
      "revert",
      "api-port",
      latest,
      "--expected-change-id",
      latest,
      "--reason",
      "undo move",
    );
    expect(result.exitCode).toBe(0);
    const show = await cli("--json", "mem", "show", "api-port", ...P);
    expect(JSON.parse(show.stdout).content).toBe("The API listens on 7700");
  });

  test("orc mem delete removes the memory", async () => {
    const result = await mem("delete", "api-port");
    expect(result.exitCode).toBe(0);
    const show = await mem("show", "api-port");
    expect(show.exitCode).toBe(1);
  });
});

describe("CLI - native memory and skill folders", () => {
  const dir = join(tmpdir(), `orc-cli-transfer-${Date.now()}`);
  const memDir = join(dir, "memory");
  const P = ["-p", "cli-transfer-test"];

  beforeAll(async () => {
    mkdirSync(memDir, { recursive: true });
    for (const name of ["cli-transfer-test", "cli-transfer-copy"]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ name }),
      });
      expect(res.status).toBe(201);
    }
    const added = await cli(
      "mem",
      "add",
      "build-cmd",
      "-d",
      "How to build the app",
      "-c",
      "Run bun run build from the repo root",
      ...P,
    );
    expect(added.exitCode).toBe(0);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("orc mem export writes Claude memory files and reports identical on re-run", async () => {
    const result = await cli("mem", "export", memDir, ...P);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/Exported build-cmd -> /);
    const text = readFileSync(join(memDir, "build-cmd.md"), "utf8");
    expect(text).toContain("name: build-cmd");
    expect(text).toContain("Run bun run build from the repo root");
    const again = await cli("--json", "mem", "export", memDir, "--dry-run", ...P);
    expect(JSON.parse(again.stdout).memories[0].status).toBe("identical");
  });

  test("orc mem import lists then imports into another project", async () => {
    const target = ["-p", "cli-transfer-copy"];
    const listed = await cli("mem", "import", memDir, ...target);
    expect(listed.stdout).toMatch(/\[new\] build-cmd - How to build the app/);
    const imported = await cli("mem", "import", memDir, "--all", ...target);
    expect(imported.stdout).toMatch(/Imported build-cmd/);
    const show = await cli("--json", "mem", "show", "build-cmd", ...target);
    expect(JSON.parse(show.stdout).content).toBe("Run bun run build from the repo root");
  });

  test("orc mem import warns about a near copy in the folder", async () => {
    writeFileSync(
      join(memDir, "build-command.md"),
      "---\nname: build-command\ndescription: How to build the app\n---\n\nRun bun run build from the repo root.\n",
    );
    const listed = await cli("mem", "import", memDir, ...P);
    expect(listed.stdout).toMatch(/\[duplicate\] build-command/);
    expect(listed.stdout).toMatch(/(identical|near) to build-cmd in ORC/);
  });

  test("orc skill export-to writes a skill folder and dry-run reports identical", async () => {
    const skills = join(dir, "skills");
    const result = await cli("skill", "export-to", skills, "orc-platform");
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/Exported orc-platform/);
    expect(readFileSync(join(skills, "orc-platform", "SKILL.md"), "utf8")).toContain(
      "name: orc-platform",
    );
    const again = await cli("--json", "skill", "export-to", skills, "orc-platform", "--dry-run");
    expect(JSON.parse(again.stdout).skills[0].status).toBe("identical");
    const listed = await cli("skill", "local", "--path", skills);
    expect(listed.stdout).toMatch(/orc-platform/);
  });
});
