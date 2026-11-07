import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_GITHUB_STATUS_LABELS, GithubSyncConfigSchema } from "@orc/core/github-sync";
import { getDb, getSqlite } from "@orc/db/client";
import { bridge_chats, gateway_sessions, projects, tasks } from "@orc/db/schema";
import { executeTool } from "@orc/mcp";
import { createOrcClient } from "@orc/sdk/client";
import { updateTaskStatus } from "@orc/task-service";
import { eq } from "drizzle-orm";
import { type GithubSyncDeps, syncGithubProject } from "../git/issue-sync.js";
import { LIVE_CHAT_ID } from "../sessions/common.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof setupTestApp>;
let projectId: string;
type RemoteIssue = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason: string | null;
  labels: { name: string }[];
  updated_at: string;
  pull_request?: unknown;
};
let issues: RemoteIssue[];
let primaryIssue: RemoteIssue;
let requests: {
  path: string;
  query: string;
  method: string;
  body: Record<string, unknown> | undefined;
}[];
let failure: number | undefined;
let failNextWrite: boolean;
let repositoryLabels: Set<string>;
const deps: GithubSyncDeps = {
  auth: async () => ({ source: "token", token: "fixture-token" }),
  fetch: (async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path: url.pathname, query: url.search, method, body });
    if (failure) return new Response("private server error fixture", { status: failure });
    if (failNextWrite && method !== "GET") {
      failNextWrite = false;
      return new Response("failure", { status: 503 });
    }
    if (url.pathname.endsWith("/labels") && !url.pathname.includes("/issues/")) {
      if (method === "POST") repositoryLabels.add(body.name);
      return Response.json(
        { name: body?.name ?? "fixture" },
        { status: method === "POST" ? 201 : 200 },
      );
    }
    if (url.pathname.includes("/labels/") && !url.pathname.includes("/issues/")) {
      const name = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      return repositoryLabels.has(name)
        ? Response.json({ name })
        : new Response("missing", { status: 404 });
    }
    const number = Number(url.pathname.split("/")[5]);
    const issue = issues.find((item) => item.number === number);
    if (url.pathname.endsWith("/issues")) {
      const filtered =
        url.searchParams.get("state") === "open"
          ? issues.filter((item) => item.state === "open")
          : issues;
      const offset = (Number(url.searchParams.get("page") ?? "1") - 1) * 100;
      return Response.json(filtered.slice(offset, offset + 100));
    }
    if (!issue) return new Response("missing", { status: 404 });
    if (method === "PATCH") Object.assign(issue, body);
    if (method === "DELETE")
      issue.labels = issue.labels.filter(
        (item) => item.name !== decodeURIComponent(url.pathname.split("/").at(-1) ?? ""),
      );
    if (method === "POST")
      for (const label of body.labels as string[])
        if (!issue.labels.some((existing) => existing.name === label))
          issue.labels.push({ name: label });
    return method === "DELETE"
      ? new Response(null, { status: 204 })
      : method === "POST"
        ? Response.json(issue.labels)
        : Response.json(issue);
  }) as typeof fetch,
};

beforeEach(async () => {
  app = setupTestApp();
  const response = await req(app, "POST", "/projects", {
    name: "github-sync",
    git_remote_url: "https://github.com/example/repo.git",
    github_sync: { enabled: true },
  });
  expect(response.status).toBe(201);
  projectId = (await response.json()).id;
  primaryIssue = {
    id: 100,
    number: 1,
    title: "External issue",
    body: "Issue description",
    state: "open",
    state_reason: null,
    labels: [{ name: "bug" }],
    updated_at: "2026-11-07T08:00:00Z",
  };
  issues = [primaryIssue];
  requests = [];
  failure = undefined;
  failNextWrite = false;
  repositoryLabels = new Set(Object.values(DEFAULT_GITHUB_STATUS_LABELS));
});
afterEach(teardownTestApp);

async function taskRow() {
  const task = await getDb().query.tasks.findFirst({ where: eq(tasks.github_issue_id, "100") });
  if (!task?.github_sync) throw new Error("Expected imported task");
  return { ...task, github_sync: task.github_sync };
}

describe("GitHub issues as native tasks", () => {
  test("should retain connected sessions, comments, dependencies and workflow settings across issue resync", async () => {
    await syncGithubProject(projectId, deps);
    const task = await taskRow();
    await getDb()
      .insert(bridge_chats)
      .values({ id: LIVE_CHAT_ID, platform: "telegram", chat_id: LIVE_CHAT_ID })
      .onConflictDoNothing();
    await getDb().insert(gateway_sessions).values({
      id: "linked-issue-session",
      chat_id: LIVE_CHAT_ID,
      backend: "codex",
      mode: "direct",
      runtime_session_id: "issue-session-probe",
      title: "Session-link verification",
      project_id: projectId,
      status: "stopped",
    });
    const linked = await req(app, "PATCH", "/sessions/live/linked-issue-session", {
      task_id: task.id,
    });
    expect(linked.status).toBe(200);
    expect((await linked.json()).task.id).toBe(task.id);
    const edited = await req(app, "PATCH", `/tasks/${task.id}`, {
      priority: "high",
      progress: 35,
      flow_name: "orc-default",
      agent_backend: "codex",
    });
    expect(edited.status).toBe(200);
    expect(
      (
        await req(app, "POST", `/tasks/${task.id}/comments`, {
          content: "Local evidence stays attached",
        })
      ).status,
    ).toBe(201);
    const other = await (
      await req(app, "POST", "/tasks", { title: "Native dependency", project_id: projectId })
    ).json();
    expect(
      (
        await req(app, "POST", `/tasks/${task.id}/links`, {
          to_task_id: other.id,
          link_type: "relates_to",
        })
      ).status,
    ).toBe(201);
    primaryIssue.title = "Updated upstream issue title";
    expect((await syncGithubProject(projectId, deps)).error).toBeNull();
    const refreshed = await taskRow();
    expect(refreshed).toMatchObject({
      id: task.id,
      title: primaryIssue.title,
      priority: "high",
      progress: 35,
      flow_name: "orc-default",
      agent_backend: "codex",
      auto_start: false,
    });
    const sessions = await (
      await req(app, "GET", `/sessions/live?task_id=${task.id}&active=false`)
    ).json();
    expect(sessions.sessions).toHaveLength(1);
    expect(sessions.sessions[0]).toMatchObject({
      id: "linked-issue-session",
      task: { id: task.id, title: primaryIssue.title },
    });
    expect(
      (await (await req(app, "GET", `/tasks/${task.id}/comments`)).json()).comments[0].content,
    ).toBe("Local evidence stays attached");
    expect((await (await req(app, "GET", `/tasks/${task.id}/links`)).json()).links).toHaveLength(1);
    expect(
      (await req(app, "PATCH", "/sessions/live/linked-issue-session", { task_id: null })).status,
    ).toBe(200);
    expect(
      (await (await req(app, "GET", `/sessions/live?task_id=${task.id}&active=false`)).json())
        .sessions,
    ).toHaveLength(0);
  });
  test("should import once, adopt an existing link, filter PRs, and expose the same task via API", async () => {
    const created = await req(app, "POST", "/tasks", {
      project_id: projectId,
      title: "Linked task",
      github_issue: "https://github.com/example/repo/issues/1",
    });
    const existingId = (await created.json()).id;
    issues.push({ ...primaryIssue, id: 101, number: 2, pull_request: {} });
    expect((await syncGithubProject(projectId, deps)).error).toBeNull();
    expect((await syncGithubProject(projectId, deps)).error).toBeNull();
    const list = await (await req(app, "GET", `/tasks?project_id=${projectId}`)).json();
    expect(list.tasks).toHaveLength(1);
    expect(list.tasks[0]).toMatchObject({
      id: existingId,
      title: "External issue",
      github_sync: { issue_id: "100", error: null },
    });
  });

  test("should keep imported agent-labelled and review issues out of automatic work and review", async () => {
    primaryIssue.labels = [{ name: "agent" }, { name: "status:review" }];
    await syncGithubProject(projectId, deps);
    const task = await taskRow();
    expect(task.auto_start).toBe(false);
    await getDb()
      .update(tasks)
      .set({ status: "todo", skill_name: "orc-sdlc" })
      .where(eq(tasks.id, task.id));
    expect((await taskRow()).auto_start).toBe(false);
  });

  test("should synchronize every outgoing status and preserve ordinary labels", async () => {
    await syncGithubProject(projectId, deps);
    const task = await taskRow();
    for (const status of [
      "doing",
      "review",
      "changes_requested",
      "blocked",
      "paused",
      "queued",
      "done",
      "cancelled",
      "todo",
    ] as const) {
      await getDb().update(tasks).set({ status }).where(eq(tasks.id, task.id));
      expect((await syncGithubProject(projectId, deps)).error).toBeNull();
      expect(primaryIssue.labels.map((label) => label.name).sort()).toEqual(
        ["bug", DEFAULT_GITHUB_STATUS_LABELS[status]].sort(),
      );
      expect(primaryIssue.state).toBe(["done", "cancelled"].includes(status) ? "closed" : "open");
      if (status === "cancelled") expect(primaryIssue.state_reason).toBe("not_planned");
      expect((await taskRow()).github_sync?.status).toBe(status);
    }
    expect(
      requests.some((request) => request.method === "PATCH" && "labels" in (request.body ?? {})),
    ).toBe(false);
  });

  test("should pull changed labels, closure reasons, and reopen through task transitions", async () => {
    await syncGithubProject(projectId, deps);
    primaryIssue.labels = [{ name: "status:doing" }];
    await syncGithubProject(projectId, deps);
    expect((await taskRow()).status).toBe("doing");
    primaryIssue.state = "closed";
    primaryIssue.state_reason = "not_planned";
    await syncGithubProject(projectId, deps);
    expect((await taskRow()).status).toBe("cancelled");
    primaryIssue.state = "open";
    primaryIssue.labels = [];
    await syncGithubProject(projectId, deps);
    expect((await taskRow()).status).toBe("todo");
  });

  test("should surface label and concurrent-status conflicts without writes, then recover", async () => {
    await syncGithubProject(projectId, deps);
    const task = await taskRow();
    await getDb().update(tasks).set({ status: "doing" }).where(eq(tasks.id, task.id));
    primaryIssue.labels = [{ name: "status:review" }];
    requests = [];
    expect((await syncGithubProject(projectId, deps)).error).not.toBeNull();
    expect((await taskRow()).github_sync?.error).toContain("both ORC and GitHub");
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    primaryIssue.labels = [{ name: "status:doing" }];
    expect((await syncGithubProject(projectId, deps)).error).toBeNull();
    primaryIssue.labels.push({ name: "status:review" });
    expect((await syncGithubProject(projectId, deps)).error).not.toBeNull();
    expect((await taskRow()).github_sync?.error).toContain("Conflicting");
  });

  test("should expose sanitized auth failures and retry interrupted outgoing writes", async () => {
    failure = 403;
    expect((await syncGithubProject(projectId, deps)).error).toContain("permission");
    expect(
      (await getDb().query.projects.findFirst({ where: eq(projects.id, projectId) }))
        ?.github_sync_state?.error,
    ).not.toContain("private");
    failure = undefined;
    await syncGithubProject(projectId, deps);
    const task = await taskRow();
    await getDb().update(tasks).set({ status: "review" }).where(eq(tasks.id, task.id));
    failNextWrite = true;
    expect((await syncGithubProject(projectId, deps)).error).not.toBeNull();
    expect((await taskRow()).github_sync?.pending_status).toBe("review");
    expect((await syncGithubProject(projectId, deps)).error).toBeNull();
    expect((await taskRow()).github_sync?.pending_status).toBeNull();
    expect(primaryIssue.labels.map((label) => label.name)).toContain("status:review");
  });

  test("should enforce project configuration, distinct labels and disabled sync", async () => {
    expect(
      GithubSyncConfigSchema.safeParse({
        enabled: true,
        status_labels: { ...DEFAULT_GITHUB_STATUS_LABELS, doing: "status:todo" },
      }).success,
    ).toBe(false);
    expect(
      (
        await req(app, "PATCH", `/projects/${projectId}`, {
          git_remote_url: "https://example.com/repo.git",
        })
      ).status,
    ).toBe(400);
    await req(app, "PATCH", `/projects/${projectId}`, { github_sync: { enabled: false } });
    expect((await syncGithubProject(projectId, deps)).error).toContain("disabled");
    expect(requests).toEqual([]);
    expect(getSqlite().query("SELECT count(*) as n FROM tasks").get()).toEqual({ n: 0 });
  });

  test("should expose imported tasks and status writes through API, SDK and MCP with scope checks", async () => {
    await syncGithubProject(projectId, deps);
    const task = await taskRow();
    expect(await executeTool("task_list", { project: "github-sync" })).toContain("GitHub #1");
    expect(await executeTool("task_get", { ids: [task.id] })).toContain(
      "https://github.com/example/repo/issues/1",
    );
    expect(await executeTool("task_update", { id: task.id, status: "doing" })).toContain("Updated");
    await syncGithubProject(projectId, deps);
    expect(primaryIssue.labels.map((label) => label.name)).toContain("status:doing");
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    try {
      const client = createOrcClient({
        baseUrl: `http://127.0.0.1:${server.port}`,
        secret: "test-secret",
      });
      expect((await client.tasks.list({ project_id: projectId })).data?.tasks[0]?.id).toBe(task.id);
      expect((await client.projects.get(projectId)).data?.github_sync?.enabled).toBe(true);
      expect((await client.tasks.update(task.id, { status: "review" })).error).toBeNull();
    } finally {
      await server.stop(true);
    }
    await expect(
      executeTool(
        "github_sync",
        { project: "github-sync", run: false },
        { projectScopes: [{ id: "other", name: "other" }] },
      ),
    ).rejects.toThrow();
    const config = JSON.parse(
      await executeTool("github_sync", { project: "github-sync", run: false }),
    );
    expect(config.config.enabled).toBe(true);
  });

  test("should protect the sync route and imported identity and content before any status change", async () => {
    expect(
      (await app.request(`/api/projects/${projectId}/github-sync`, { method: "POST" })).status,
    ).toBe(401);
    expect((await req(app, "POST", "/projects/unknown/github-sync")).status).toBe(404);
    await syncGithubProject(projectId, deps);
    const task = await taskRow();
    expect(
      (await req(app, "PATCH", `/tasks/${task.id}`, { title: "Changed", status: "done" })).status,
    ).toBe(400);
    expect((await taskRow()).status).toBe("todo");
    await expect(executeTool("task_update", { id: task.id, body: "Changed" })).rejects.toThrow(
      "GitHub",
    );
    expect((await req(app, "PATCH", `/tasks/${task.id}`, { project_id: "other" })).status).toBe(
      400,
    );
  });

  test("should serialize overlapping sync calls and isolate the same issue across projects", async () => {
    await Promise.all([syncGithubProject(projectId, deps), syncGithubProject(projectId, deps)]);
    expect(requests.filter((request) => request.path.endsWith("/issues"))).toHaveLength(1);
    const second = await (
      await req(app, "POST", "/projects", {
        name: "second",
        git_remote_url: "git@github.com:example/repo.git",
        github_sync: { enabled: true },
      })
    ).json();
    await syncGithubProject(second.id, deps);
    expect(
      getSqlite().query("SELECT count(*) as n FROM tasks WHERE github_issue_id='100'").get(),
    ).toEqual({ n: 2 });
  });

  test("should retain task and project errors across retries without leaking tokens or upstream errors", async () => {
    const noAuth = await syncGithubProject(projectId, {
      ...deps,
      auth: async () => ({ source: "none" }),
    });
    expect(noAuth.error).toContain("authentication required");
    expect(requests).toEqual([]);
    await syncGithubProject(projectId, deps);
    const task = await taskRow();
    await getDb().update(tasks).set({ status: "review" }).where(eq(tasks.id, task.id));
    await getDb()
      .update(tasks)
      .set({ github_sync: { ...task.github_sync, pending_status: "review" } })
      .where(eq(tasks.id, task.id));
    primaryIssue.state = "closed";
    primaryIssue.state_reason = "completed";
    requests = [];
    expect((await syncGithubProject(projectId, deps)).error).not.toBeNull();
    expect((await taskRow()).github_sync?.error).toContain("closed during");
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  test("should retry a blocked inbound adoption without pushing the old native status to GitHub", async () => {
    const created = await (
      await req(app, "POST", "/tasks", {
        title: "Existing link",
        project_id: projectId,
        github_issue: "https://github.com/example/repo/issues/1",
      })
    ).json();
    const blocker = await (
      await req(app, "POST", "/tasks", { title: "Blocker", project_id: projectId })
    ).json();
    getSqlite()
      .query(
        "INSERT INTO task_links(id,from_task_id,to_task_id,link_type) VALUES ('block',?,?,'blocks')",
      )
      .run(blocker.id, created.id);
    primaryIssue.labels = [{ name: "status:doing" }];
    expect((await syncGithubProject(projectId, deps)).error).not.toBeNull();
    expect((await taskRow()).github_sync.status).toBe("todo");
    expect((await taskRow()).auto_start).toBe(false);
    requests = [];
    await syncGithubProject(projectId, deps);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect((await taskRow()).status).toBe("todo");
    await getDb().update(tasks).set({ status: "done" }).where(eq(tasks.id, blocker.id));
    expect((await syncGithubProject(projectId, deps)).error).toBeNull();
    expect((await taskRow()).status).toBe("doing");
  });

  test("should reject stale inbound expectations before changing a task or adding a comment", async () => {
    await syncGithubProject(projectId, deps);
    const task = await taskRow();
    const result = await updateTaskStatus({
      taskId: task.id,
      expectedStatus: "review",
      status: "done",
      comment: "Must not be written",
    });
    expect(result.ok).toBe(false);
    expect((await taskRow()).status).toBe("todo");
    expect(
      getSqlite().query("SELECT count(*) as n FROM comments WHERE resource_id=?").get(task.id),
    ).toEqual({ n: 0 });
  });

  test("should create a missing custom status label when first needed and preserve ordinary labels", async () => {
    await req(app, "PATCH", `/projects/${projectId}`, {
      github_sync: {
        enabled: true,
        status_labels: { ...DEFAULT_GITHUB_STATUS_LABELS, doing: "in-progress" },
      },
    });
    await syncGithubProject(projectId, deps);
    const task = await taskRow();
    await getDb().update(tasks).set({ status: "doing" }).where(eq(tasks.id, task.id));
    expect((await syncGithubProject(projectId, deps)).error).toBeNull();
    expect(repositoryLabels.has("in-progress")).toBe(true);
    expect(primaryIssue.labels.map((label) => label.name).sort()).toEqual(["bug", "in-progress"]);
    expect(
      requests.filter(
        (request) => request.method === "POST" && request.path === "/repos/example/repo/labels",
      ),
    ).toHaveLength(1);
  });

  test("should paginate initial import and use the successful cursor on subsequent cycles", async () => {
    issues = Array.from({ length: 101 }, (_, index) => ({
      ...primaryIssue,
      id: 100 + index,
      number: index + 1,
    }));
    expect((await syncGithubProject(projectId, deps)).error).toBeNull();
    expect(getSqlite().query("SELECT count(*) as n FROM tasks").get()).toEqual({ n: 101 });
    expect(requests.filter((request) => request.path.endsWith("/issues"))).toHaveLength(2);
    requests = [];
    await syncGithubProject(projectId, deps);
    expect(requests[0]?.query).toContain("state=all");
    expect(requests[0]?.query).toContain("since=");
  });

  test("should stop applying a fetched page when project sync is disabled during the request", async () => {
    const result = await syncGithubProject(projectId, {
      ...deps,
      fetch: (async (input, init) => {
        const response = await deps.fetch?.(input, init);
        await getDb()
          .update(projects)
          .set({ github_sync: { enabled: false, status_labels: DEFAULT_GITHUB_STATUS_LABELS } })
          .where(eq(projects.id, projectId));
        if (!response) throw new Error("Fixture response missing");
        return response;
      }) as typeof fetch,
    });
    expect(result.error).toContain("settings changed");
    expect(getSqlite().query("SELECT count(*) as n FROM tasks").get()).toEqual({ n: 0 });
  });

  test("should refuse to report success if GitHub silently omits the requested label", async () => {
    await syncGithubProject(projectId, deps);
    const task = await taskRow();
    await getDb().update(tasks).set({ status: "doing" }).where(eq(tasks.id, task.id));
    const result = await syncGithubProject(projectId, {
      ...deps,
      fetch: (async (input, init) => {
        if (init?.method === "POST" && String(input).includes("/issues/1/labels"))
          return Response.json([]);
        const response = await deps.fetch?.(input, init);
        if (!response) throw new Error("Fixture response missing");
        return response;
      }) as typeof fetch,
    });
    expect(result.error).not.toBeNull();
    expect((await taskRow()).github_sync.error).toContain("did not retain");
  });
});
