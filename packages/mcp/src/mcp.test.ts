import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getUserAgentsDir } from "@orc/core/agent-service";
import { globalConfigPath, loadConfig, resetConfig } from "@orc/core/config";
import { ConflictError } from "@orc/core/errors";
import { shortId, ulid } from "@orc/core/ids";
import { closeDb, createTestDb, getSqlite } from "@orc/db/client";
import { toolListing } from "./server.js";
import { executeTool, toolDefinitions } from "./tools.js";

const originalActiveProject = process.env.ORC_ACTIVE_PROJECT;
const originalOrcHome = process.env.ORC_HOME;
const testOrcHome = mkdtempSync(join(tmpdir(), "orc-mcp-home-"));

beforeAll(() => {
  process.env.ORC_HOME = testOrcHome;
  process.env.ORC_API_SECRET = "test-secret";
  process.env.ORC_DB_PATH = ":memory:";
  process.env.ORC_ACTIVE_PROJECT = "";
  resetConfig();
  createTestDb();
});

afterAll(() => {
  if (originalActiveProject === undefined) delete process.env.ORC_ACTIVE_PROJECT;
  else process.env.ORC_ACTIVE_PROJECT = originalActiveProject;
  if (originalOrcHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = originalOrcHome;
  closeDb();
  resetConfig();
  delete process.env.ORC_API_SECRET;
  delete process.env.ORC_DB_PATH;
  rmSync(testOrcHome, { recursive: true, force: true });
});

// ── Task tools ────────────────────────────────────────────────────────────────

describe("MCP task tools", () => {
  let taskId: string;

  test("task_create creates a task", async () => {
    const result = await executeTool("task_create", {
      title: "Write MCP integration tests",
      body: "Cover memory, task, and job tools",
      priority: "high",
      author: "agent",
    });
    expect(result).toMatch(/^Created: /);
    taskId = result.split(" - ")[0]?.replace("Created: ", "").trim() ?? "";
  });

  test("task_list shows the new task", async () => {
    const result = await executeTool("task_list", { limit: 10 });
    expect(result).toContain(shortId(taskId));
  });

  test("task_get returns full task detail", async () => {
    const result = await executeTool("task_get", { ids: [taskId] });
    expect(result).toContain("Write MCP integration tests");
  });

  test("task_update changes status", async () => {
    const result = await executeTool("task_update", {
      id: taskId,
      status: "doing",
    });
    expect(result).toBe(`Updated: ${taskId}`);
  });

  test("task_update to review with comment", async () => {
    const result = await executeTool("task_update", {
      id: taskId,
      status: "review",
      comment: "Tests written and passing",
    });
    expect(result).toBe(`Updated: ${taskId}`);
  });

  test("task_update edits fields and task_get shows them with comments", async () => {
    const pr = "https://github.com/acme/repo/pull/7";
    expect(
      await executeTool("task_update", {
        id: taskId,
        title: "Renamed task",
        tags: ["mcp-tag"],
        git_branch: "feat/x",
        github_pr: pr,
        due_at: "2030-01-01T00:00:00.000Z",
        comment: "same-status note",
      }),
    ).toBe(`Updated: ${taskId}`);
    const detail = await executeTool("task_get", { ids: [taskId] });
    expect(detail).toContain("Renamed task");
    expect(detail).toContain("Branch: feat/x");
    expect(detail).toContain(`PR: ${pr}`);
    expect(detail).toContain("Tests written and passing");
    expect(detail).toContain("same-status note");
  });

  test("task_list filters by tag and lists any status", async () => {
    expect(await executeTool("task_list", { tag: "mcp-tag" })).toContain(shortId(taskId));
    expect(await executeTool("task_list", { tag: "absent-tag" })).not.toContain(shortId(taskId));
    expect(await executeTool("task_list", { status: "done" })).toBe("No done tasks.");
  });

  test("task_update and task_get reject unknown tasks", async () => {
    await expect(executeTool("task_update", { id: "missing-task", title: "x" })).rejects.toThrow();
    expect(await executeTool("task_get", { ids: ["missing-task"] })).toContain("Task not found");
  });

  test("task_link adds, lists and removes links", async () => {
    const other = await executeTool("task_create", { title: "Linked task" });
    const otherId = other.split(" - ")[0]?.replace("Created: ", "").trim() ?? "";
    const added = await executeTool("task_link", {
      id: taskId,
      action: "add",
      to_task_id: otherId,
      link_type: "blocks",
    });
    const linkId = added.match(/\[link: (\w+)\]/)?.[1] ?? "";
    expect(linkId).not.toBe("");
    await expect(
      executeTool("task_link", {
        id: taskId,
        action: "add",
        to_task_id: otherId,
        link_type: "blocks",
      }),
    ).rejects.toThrow("Link already exists");
    await expect(
      executeTool("task_link", {
        id: taskId,
        action: "add",
        to_task_id: taskId,
        link_type: "blocks",
      }),
    ).rejects.toThrow("itself");
    expect(await executeTool("task_link", { id: otherId })).toContain(`[link: ${linkId}]`);
    expect(await executeTool("task_link", { id: taskId, action: "remove", link_id: linkId })).toBe(
      `Removed link ${linkId}`,
    );
    expect(await executeTool("task_link", { id: taskId })).toBe(`No links for task ${taskId}.`);
  });

  test("connection defaults never block ID-only tools", async () => {
    const scoped = { projectScopes: [{ id: "other-project", name: "other" }] };
    await expect(executeTool("task_link", { id: taskId }, scoped)).resolves.toContain("No links");
    await expect(executeTool("flow_status", { task: taskId }, scoped)).resolves.toBeString();
    await expect(
      executeTool("task_update", { id: taskId, title: "x" }, scoped),
    ).resolves.toBeString();
  });
});

// ── Job tools ─────────────────────────────────────────────────────────────────

describe("MCP job tools", () => {
  let runId: string;

  test("job_list returns a string result", async () => {
    const result = await executeTool("job_list", { limit: 10 });
    expect(typeof result).toBe("string");
  });

  test("job_run triggers and executes a job", async () => {
    const { getDb } = await import("@orc/db/client");
    const { jobs } = await import("@orc/db/schema");
    const { ulid } = await import("@orc/core/ids");
    const db = getDb();
    const jobId = ulid();
    const now = new Date();
    await db.insert(jobs).values({
      id: jobId,
      name: "mcp-test-job",
      command: "echo mcp-works",
      trigger_type: "manual",
      created_at: now,
      updated_at: now,
    });

    const result = await executeTool("job_run", { name: "mcp-test-job" });
    expect(result).toContain("mcp-test-job");
    expect(result).toContain("run_id");
    runId = result.split("run_id: ")[1]?.trim() ?? "";
  });

  test("job_status returns run status", async () => {
    await Bun.sleep(400);
    const result = await executeTool("job_status", { run_id: runId });
    const parsed = JSON.parse(result) as {
      status: string;
      exit_code: number | null;
    };
    expect(["success", "running", "pending"]).toContain(parsed.status);
  });

  test("job_status returns log lines on request", async () => {
    let parsed: { status: string; logs?: { stream: string; line: string }[] } = { status: "" };
    for (let i = 0; i < 50 && parsed.status !== "success"; i++) {
      parsed = JSON.parse(await executeTool("job_status", { run_id: runId, logs: true }));
      if (parsed.status !== "success") await Bun.sleep(100);
    }
    expect(parsed.status).toBe("success");
    expect(parsed.logs?.some((l) => l.stream === "stdout" && l.line.includes("mcp-works"))).toBe(
      true,
    );
    expect(JSON.parse(await executeTool("job_status", { run_id: runId })).logs).toBeUndefined();
  });
});

// ── Agent and package tools ───────────────────────────────────────────────────

describe("MCP agent and package tools", () => {
  const originalEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    ORC_PACKAGES_DIR: process.env.ORC_PACKAGES_DIR,
  };
  let home: string;

  beforeAll(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "orc-mcp-agents-")));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.ORC_PACKAGES_DIR = join(home, "packages");
    expect(getUserAgentsDir().startsWith(home)).toBe(true);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  test("agent_update and agent_delete honor the read snapshot", async () => {
    const created = JSON.parse(
      await executeTool("agent_create", {
        id: "mcp-reviewer",
        content: "---\ndescription: Review\n---\nOriginal.",
      }),
    ) as { path: string; raw: string };
    const updated = JSON.parse(
      await executeTool("agent_update", {
        id: "mcp-reviewer",
        content: "---\ndescription: Review\n---\nUpdated.",
        expected_raw: created.raw,
        expected_path: created.path,
      }),
    ) as { raw: string; content: string };
    expect(updated.content).toContain("Updated.");
    await expect(
      executeTool("agent_update", {
        id: "mcp-reviewer",
        content: "stale",
        expected_raw: created.raw,
        expected_path: created.path,
      }),
    ).rejects.toThrow();
    await expect(
      executeTool("agent_delete", { id: "mcp-reviewer", expected_raw: created.raw }),
    ).rejects.toThrow("changed since you read it");
    expect(
      await executeTool("agent_delete", { id: "mcp-reviewer", expected_raw: updated.raw }),
    ).toBe("Deleted agent mcp-reviewer");
    expect(await executeTool("agent_read", { id: "mcp-reviewer" })).toBe(
      "Agent not found: mcp-reviewer",
    );
  });

  test("agent_package_update and agent_package_delete require the current revision", async () => {
    await executeTool("agent_package_import", {
      name: "mcp-pkg",
      content: "name: mcp-pkg\nversion: 1.0.0\n",
      files: [{ path: "references/a.md", content: "A" }],
    });
    const read = JSON.parse(await executeTool("agent_package_read", { name: "mcp-pkg" })) as {
      revision: string;
    };
    expect(read.revision).toMatch(/^[0-9a-f]{64}$/);
    const updated = JSON.parse(
      await executeTool("agent_package_update", {
        name: "mcp-pkg",
        content: "name: mcp-pkg\nversion: 2.0.0\n",
        files: [],
        expected_revision: read.revision,
      }),
    ) as { revision: string; files: unknown[]; manifest: { version: string } };
    expect(updated.manifest.version).toBe("2.0.0");
    expect(updated.files).toEqual([]);
    await expect(
      executeTool("agent_package_delete", { name: "mcp-pkg", expected_revision: read.revision }),
    ).rejects.toThrow();
    expect(
      await executeTool("agent_package_delete", {
        name: "mcp-pkg",
        expected_revision: updated.revision,
      }),
    ).toBe("Deleted package mcp-pkg");
  });
});

// ── Context layer ─────────────────────────────────────────────────────────────

describe("MCP context tool", () => {
  test("context returns active tasks and a memories section", async () => {
    const result = await executeTool("context", {});
    expect(result).toContain("Active Tasks");
    expect(result).toContain("## Memories");
  });
});

describe("MCP skill tools", () => {
  test("should count skill_read and list most-read skills first", async () => {
    await executeTool("skill_read", { name: "orc-platform", scope: "global" });
    await executeTool("skill_read", { name: "orc-platform", scope: "global", ref: "SKILL.md" });
    const listing = await executeTool("skill_list", { scope: "global", limit: 1 });
    expect(listing.split("\n")[0]).toContain("orc-platform");
    expect(listing).toContain("(2 reads)");
    expect(listing).toMatch(/Showing 1 of \d+; total=\d+, offset=0, limit=1, next_offset=1/);
  });

  test("should not count a read of a missing skill", async () => {
    expect(await executeTool("skill_read", { name: "missing-skill-xyz" })).toContain(
      "Skill not found",
    );
    const listing = await executeTool("skill_list", { q: "missing-skill-xyz" });
    // Diagnostics about installed skills follow the catalog and do not represent search hits.
    expect(listing.split("\n")[0]).toBe("No skills found.");
  });
});

describe("Removed legacy session log tools & session_search agent schema", () => {
  test("legacy session_event, session_snapshot, session_restore, session_log are not registered", () => {
    const names = new Set<string>(toolDefinitions.map((tool) => tool.name));
    for (const removed of ["session_event", "session_snapshot", "session_restore", "session_log"]) {
      expect(names.has(removed)).toBe(false);
    }
  });

  test("session_search accepts opencode, pi, and other harnesses and rejects unknown agents", () => {
    const schema = toolDefinitions.find((tool) => tool.name === "session_search")?.inputSchema;
    expect(schema).toBeDefined();
    for (const agent of ["claude", "codex", "opencode", "pi", "cursor", "gemini"]) {
      expect(schema?.safeParse({ q: "test", agent }).success).toBe(true);
    }
    const invalid = schema?.safeParse({ q: "test", agent: "nonexistent-harness" });
    expect(invalid?.success).toBe(false);
  });
});

// ── Project creation (issue #236) ─────────────────────────────────────────────

describe("MCP project_create tool", () => {
  const created: string[] = [];
  const uniqueName = () => `pc-${ulid()}`;
  const inputSchema = () => toolDefinitions.find((t) => t.name === "project_create")?.inputSchema;

  afterAll(async () => {
    if (created.length === 0) return;
    const { getDb } = await import("@orc/db/client");
    const { projects } = await import("@orc/db/schema");
    const { inArray } = await import("drizzle-orm");
    await getDb().delete(projects).where(inArray(projects.name, created));
  });

  test("creates a project and returns a stable id, name and link", async () => {
    const name = uniqueName();
    created.push(name);
    const result = await executeTool(
      "project_create",
      { name, description: "Created via MCP", tags: ["mcp"], status: "paused" },
      { publicApiBaseUrl: "https://orc.example" },
    );
    const id = /\[id: ([a-z0-9]{4,})\]/.exec(result)?.[1];
    expect(result).toContain(`Created project ${name}`);
    expect(id).toBeDefined();
    expect(result).toContain(`link: https://orc.example/tasks?project=${name}`);
    const { getDb } = await import("@orc/db/client");
    const { projects } = await import("@orc/db/schema");
    const { eq } = await import("drizzle-orm");
    const row = await getDb().query.projects.findFirst({ where: eq(projects.name, name) });
    expect(row?.id).toBe(id);
    expect(row?.description).toBe("Created via MCP");
    expect(row?.tags).toEqual(["mcp"]);
    expect(row?.status).toBe("paused");
    expect(await executeTool("project_list", {})).toContain(name);
  });

  test("validates name, status and git_remote_url like the projects API", () => {
    const schema = inputSchema();
    expect(schema).toBeDefined();
    for (const name of ["", "has space", "slash/name", "dot.name", "x".repeat(101)])
      expect(schema?.safeParse({ name }).success).toBe(false);
    expect(schema?.safeParse({ name: "Ok-Name_1" }).success).toBe(true);
    expect(schema?.safeParse({ name: "ok", status: "done" }).success).toBe(false);
    for (const git_remote_url of [
      "https://user:pass@github.com/a/b.git",
      "https://github.com/a/b?token=x",
      "not a url",
    ])
      expect(schema?.safeParse({ name: "ok", git_remote_url }).success).toBe(false);
    for (const git_remote_url of ["https://github.com/a/b.git", "git@github.com:a/b.git"])
      expect(schema?.safeParse({ name: "ok", git_remote_url }).success).toBe(true);
  });

  test("duplicate names conflict with the existing project and a retry never inserts twice", async () => {
    const name = uniqueName();
    created.push(name);
    const first = await executeTool("project_create", { name });
    const id = /\[id: ([a-z0-9]{4,})\]/.exec(first)?.[1];
    expect(id).toBeDefined();
    for (const duplicate of [name, name.toUpperCase()]) {
      const error = await executeTool("project_create", { name: duplicate }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).message).toContain(`[id: ${id}]`);
      expect((error as ConflictError).message).toContain("no duplicate was created");
    }
    const { getSqlite } = await import("@orc/db/client");
    const count = getSqlite()
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM projects WHERE name = ? COLLATE NOCASE",
      )
      .get(name)?.n;
    expect(count).toBe(1);
  });

  test("should reject concurrent project creates with different casing", async () => {
    const name = uniqueName();
    created.push(name);
    const results = await Promise.allSettled([
      executeTool("project_create", { name }),
      executeTool("project_create", { name: name.toUpperCase() }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure?.status === "rejected" && failure.reason).toBeInstanceOf(ConflictError);
  });

  test("project_create stores optional host and project_list returns it", async () => {
    const name = uniqueName();
    created.push(name);
    const createdText = await executeTool("project_create", {
      name,
      scope: "/home/dev/repo",
      host: "devbox",
    });
    expect(createdText).toContain(`Created project ${name}`);
    const listText = await executeTool("project_list", {});
    expect(listText).toContain(`${name}`);
    expect(listText).toContain("[host: devbox]");
  });

  test("project_create works on a connection that has default projects", async () => {
    const name = uniqueName();
    created.push(name);
    const text = await executeTool(
      "project_create",
      { name },
      { projectScopes: [{ id: "scope-id", name: "scope" }] },
    );
    expect(text).toContain(`Created project ${name}`);
  });

  test("creating a project clears setup_dismissed in config.json and loadConfig()", async () => {
    const throwawayHome = mkdtempSync(join(tmpdir(), "orc-mcp-dismissal-"));
    const previousOrcHome = process.env.ORC_HOME;
    const name = uniqueName();
    created.push(name);
    try {
      process.env.ORC_HOME = throwawayHome;
      writeFileSync(
        join(throwawayHome, "config.json"),
        `${JSON.stringify({ preferences: { setup_dismissed: true } }, null, 2)}\n`,
      );
      resetConfig();
      expect(globalConfigPath()).toBe(join(throwawayHome, "config.json"));
      expect(loadConfig().preferences.setup_dismissed).toBe(true);

      await executeTool("project_create", { name });

      const saved = JSON.parse(readFileSync(globalConfigPath(), "utf8")) as {
        preferences?: { setup_dismissed?: boolean };
      };
      expect(saved.preferences?.setup_dismissed).toBeUndefined();
      expect(loadConfig().preferences.setup_dismissed).toBeUndefined();
    } finally {
      if (previousOrcHome === undefined) delete process.env.ORC_HOME;
      else process.env.ORC_HOME = previousOrcHome;
      resetConfig();
      rmSync(throwawayHome, { recursive: true, force: true });
    }
  });
});

// ── HTTP endpoint ─────────────────────────────────────────────────────────────

describe("MCP /mcp/tool HTTP endpoint", () => {
  let app: {
    request: (path: string, init?: RequestInit) => Response | Promise<Response>;
  };

  beforeAll(async () => {
    const { createApp } = await import("@orc/api/server");
    app = createApp();
  });

  test("POST /mcp/tool executes memory_create via API", async () => {
    const { getDb } = await import("@orc/db/client");
    const { projects } = await import("@orc/db/schema");
    await getDb().insert(projects).values({ id: "mcp-http-project", name: "mcp-http-project" });
    const res = await app.request("/api/mcp/tool", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret",
      },
      body: JSON.stringify({
        name: "memory_create",
        args: {
          name: "hook-test-fact",
          description: "Hook test fact",
          content: "Hook test fact content",
          project: "mcp-http-project",
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: string };
    expect(body.result).toBe("Created memory hook-test-fact");
  });

  test("POST /mcp/tool returns 400 for unknown tool name", async () => {
    const res = await app.request("/api/mcp/tool", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret",
      },
      body: JSON.stringify({ name: "does_not_exist", args: {} }),
    });

    expect(res.status).toBe(400);
  });
});

// ── Advertised tool schemas ─────────────────────────────────────────────────

describe("MCP tool schemas", () => {
  const advertised = () =>
    toolListing().map((t) => ({
      name: t.name,
      schema: t.inputSchema as {
        type?: string;
        properties?: Record<string, unknown>;
        required?: string[];
      },
    }));

  test("every tool advertises an object schema", () => {
    for (const { name, schema } of advertised()) {
      expect(`${name}:${schema.type}`).toBe(`${name}:object`);
    }
  });

  test("every tool that takes arguments advertises them", () => {
    const argless = new Set(["project_list", "agent_list", "agent_package_list"]);
    for (const { name, schema } of advertised()) {
      if (argless.has(name)) continue;
      const props = Object.keys(schema.properties ?? {});
      expect(`${name}:${props.length > 0}`).toBe(`${name}:true`);
    }
  });

  test("task_update advertises id as required and status as an enum", () => {
    const schema = advertised().find((t) => t.name === "task_update")?.schema;
    expect(schema?.required).toEqual(["id"]);
    expect((schema?.properties?.status as { enum?: string[] })?.enum).toContain("review");
  });

  test("defaulted fields are optional on the input schema", () => {
    const schema = advertised().find((t) => t.name === "task_list")?.schema;
    expect(schema?.properties).toHaveProperty("limit");
    expect(schema?.required ?? []).not.toContain("limit");
  });
});

// Commands run through the host shell (sh on POSIX, cmd on Windows).
const detachedEcho = (text: string): string =>
  process.platform === "win32"
    ? `echo "${text}" & ping -n 21 127.0.0.1 >nul`
    : `echo "${text}"; sleep 20`;

describe("MCP detached shell tools", () => {
  test("shell_run starts detached command, shell_status reads output, shell_list lists it, and shell_stop stops it", async () => {
    const started = JSON.parse(
      await executeTool("shell_run", {
        command: detachedEcho("mcp-shell-ok"),
        cwd: process.cwd(),
        label: "mcp-shell-test",
      }),
    ) as { id: string; status: string };
    expect(started.status).toBe("running");
    try {
      let statusBody: { status: string; log_tail?: string } = { status: "running" };
      for (let i = 0; i < 40; i++) {
        statusBody = JSON.parse(
          await executeTool("shell_status", { job_id: started.id, logs: true, tail_lines: 20 }),
        ) as { status: string; log_tail?: string };
        if (statusBody.log_tail?.includes("mcp-shell-ok")) break;
        await Bun.sleep(25);
      }
      expect(statusBody.log_tail).toContain("mcp-shell-ok");

      const listed = JSON.parse(await executeTool("shell_list", { limit: 20 })) as {
        jobs: { id: string }[];
      };
      expect(listed.jobs.some((j) => j.id === started.id)).toBe(true);

      const stopped = JSON.parse(await executeTool("shell_stop", { job_id: started.id })) as {
        status: string;
      };
      expect(stopped.status).toBe("stopped");
    } finally {
      await executeTool("shell_stop", { job_id: started.id }).catch(() => undefined);
    }
  });

  test("shell_* tools default to the connection projects without blocking others", async () => {
    const db = getSqlite();
    const now = Math.floor(Date.now() / 1000);
    db.query(
      "INSERT OR IGNORE INTO projects (id, name, description, status, created_at, updated_at) VALUES (?, ?, '', 'active', ?, ?)",
    ).run("proj-shell-a", "shell-proj-a", now, now);
    db.query(
      "INSERT OR IGNORE INTO projects (id, name, description, status, created_at, updated_at) VALUES (?, ?, '', 'active', ?, ?)",
    ).run("proj-shell-b", "shell-proj-b", now, now);

    const scopeA = { projectScopes: [{ id: "proj-shell-a", name: "shell-proj-a" }] };
    const scopeB = { projectScopes: [{ id: "proj-shell-b", name: "shell-proj-b" }] };

    const jobA = JSON.parse(
      await executeTool(
        "shell_run",
        { command: detachedEcho("secret-a"), cwd: process.cwd(), label: "job-a" },
        scopeA,
      ),
    ) as { id: string; project_id: string | null };
    expect(jobA.project_id).toBe("proj-shell-a");

    let jobBId: string | undefined;
    try {
      const jobB = JSON.parse(
        await executeTool(
          "shell_run",
          { command: "echo nope", cwd: process.cwd(), project: "shell-proj-b" },
          scopeA,
        ),
      ) as { id: string; project_id: string | null };
      jobBId = jobB.id;
      expect(jobB.project_id).toBe("proj-shell-b");

      // Direct ids are reachable from any connection; only list defaults filter.
      expect(JSON.parse(await executeTool("shell_status", { job_id: jobA.id }, scopeB)).id).toBe(
        jobA.id,
      );

      const listB = JSON.parse(await executeTool("shell_list", { limit: 50 }, scopeB)) as {
        jobs: { id: string }[];
      };
      expect(listB.jobs.some((j) => j.id === jobA.id)).toBe(false);

      const listA = JSON.parse(await executeTool("shell_list", { limit: 50 }, scopeA)) as {
        jobs: { id: string }[];
      };
      expect(listA.jobs.some((j) => j.id === jobA.id)).toBe(true);
    } finally {
      await executeTool("shell_stop", { job_id: jobA.id }, scopeA).catch(() => undefined);
      if (jobBId)
        await executeTool("shell_stop", { job_id: jobBId }, scopeA).catch(() => undefined);
    }
  });
});
