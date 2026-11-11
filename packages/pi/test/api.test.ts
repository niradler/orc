import { afterEach, describe, expect, test } from "bun:test";
import { OrcApiClient } from "../src/api.js";

const servers: Array<{ stop(force?: boolean): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function serve(handler: (request: Request) => Response) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

describe("OrcApiClient paths", () => {
  test("every request goes under /api", async () => {
    const paths: string[] = [];
    const base = serve((request) => {
      const url = new URL(request.url);
      paths.push(url.pathname + url.search);
      return new Response(JSON.stringify({ skills: [], projects: [] }), { status: 200 });
    });
    const api = new OrcApiClient(base, undefined, 1000);
    await api.listSkills();
    await api.projectRoots();
    expect(paths).toEqual(["/api/skills?scope=all&limit=500", "/api/skills/project-folders"]);
  });
});

describe("OrcApiClient auth errors", () => {
  test("a 401 names the secret source and the fix without leaking the secret", async () => {
    const base = serve(() => new Response("Unauthorized", { status: 401 }));
    const error = await new OrcApiClient(base, "topsecret", 1000, "env")
      .listSkills()
      .catch((e) => e);
    expect(error.message).toContain("/api/skills");
    expect(error.message).toContain("secret from env was rejected");
    expect(error.message).not.toContain("topsecret");
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
