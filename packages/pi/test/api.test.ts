import { afterEach, describe, expect, test } from "bun:test";
import { OrcApiClient } from "../src/api.js";

const servers: Array<{ stop(force?: boolean): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

type Seen = { method: string; path: string; body: unknown };

function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function recorder(reply: unknown, status = 200): { base: string; seen: Seen[] } {
  const seen: Seen[] = [];
  const base = serve(async (request) => {
    const url = new URL(request.url);
    const text = await request.text();
    seen.push({
      method: request.method,
      path: url.pathname + url.search,
      body: text ? JSON.parse(text) : undefined,
    });
    return new Response(JSON.stringify(reply), { status });
  });
  return { base, seen };
}

describe("OrcApiClient requests", () => {
  test("project folders live under /api", async () => {
    const { base, seen } = recorder({ projects: [] });
    await new OrcApiClient(base, undefined, 1000).projectRoots();
    expect(seen.map((item) => item.path)).toEqual(["/api/skills/project-folders"]);
  });

  test("creates a project with its folder scope", async () => {
    const { base, seen } = recorder({ id: "p1", name: "app" }, 201);
    const created = await new OrcApiClient(base, undefined, 1000).createProject({
      name: "app",
      scope: "C:/work/app",
    });
    expect(created).toEqual({ id: "p1", name: "app" });
    expect(seen).toEqual([
      { method: "POST", path: "/api/projects", body: { name: "app", scope: "C:/work/app" } },
    ]);
  });

  test("creates and lists jobs", async () => {
    const { base, seen } = recorder({ id: "j1", name: "n", jobs: [] }, 201);
    const api = new OrcApiClient(base, undefined, 1000);
    await api.createJob({
      name: "hourly",
      trigger_type: "cron",
      cron_expr: "0 * * * *",
      enabled: true,
      action: { type: "agent", prompt: "check", backend: "pi" },
    });
    await api.listJobs("p 1");
    await api.listJobs();
    expect(seen.map((item) => `${item.method} ${item.path}`)).toEqual([
      "POST /api/jobs",
      "GET /api/jobs?project_id=p%201&limit=100",
      "GET /api/jobs?limit=100",
    ]);
    expect(seen[0]?.body).toMatchObject({ cron_expr: "0 * * * *", action: { backend: "pi" } });
  });

  test("reads and activates rules", async () => {
    const { base, seen } = recorder({ enabled: true, history: [] });
    const api = new OrcApiClient(base, undefined, 1000);
    await api.rules("C:/work/app");
    await api.activateRules({ workspace: "C:/work/app", project_id: null, rules: [] }, "r1", "why");
    expect(seen.map((item) => `${item.method} ${item.path}`)).toEqual([
      "GET /api/rules?workspace=C%3A%2Fwork%2Fapp",
      "POST /api/rules/activate",
    ]);
    expect(seen[1]?.body).toEqual({
      policy: { workspace: "C:/work/app", project_id: null, rules: [] },
      expected_id: "r1",
      reason: "why",
    });
  });
});

describe("OrcApiClient errors", () => {
  test("a 401 names the secret source and the fix without leaking the secret", async () => {
    const base = serve(() => new Response("Unauthorized", { status: 401 }));
    const error = await new OrcApiClient(base, "topsecret", 1000, "env")
      .projectRoots()
      .catch((e) => e);
    expect(error.message).toContain("/api/skills/project-folders");
    expect(error.message).toContain("secret from env was rejected");
    expect(error.message).not.toContain("topsecret");
  });

  test("keeps the status and JSON error message", async () => {
    const base = serve(() => Response.json({ error: { message: "name taken" } }, { status: 409 }));
    const error = await new OrcApiClient(base, undefined, 1000)
      .createProject({ name: "app" })
      .catch((e) => e);
    expect(error.status).toBe(409);
    expect(error.message).toContain("name taken");
  });
});

describe("OrcApiClient.health", () => {
  test("checks /api/health with the bearer secret", async () => {
    const seen: Array<{ path: string; auth: string | null }> = [];
    const base = serve((request) => {
      seen.push({
        path: new URL(request.url).pathname,
        auth: request.headers.get("authorization"),
      });
      return new Response("{}", { status: 200 });
    });

    expect(await new OrcApiClient(base, "s3cret", 1000).health()).toBe(true);
    expect(seen).toEqual([{ path: "/api/health", auth: "Bearer s3cret" }]);
  });

  test("reports down for a non-ok response or an unreachable server", async () => {
    const base = serve(() => new Response("nope", { status: 404 }));
    expect(await new OrcApiClient(base, undefined, 1000).health()).toBe(false);
    expect(await new OrcApiClient("http://127.0.0.1:1", undefined, 500).health()).toBe(false);
  });
});
