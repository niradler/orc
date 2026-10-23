import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { loadConfig, OrcConfigSchema, resetConfig } from "@orc/core/config";
import { z } from "zod";
import {
  fetchGithubFeed,
  type GithubDeps,
  githubAuth,
  githubRemote,
  readGithubCi,
} from "../git/github.js";
import { bearerAuth } from "../middleware/auth.js";
import { createGithubRouter } from "../routes/github.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

const issue = {
  number: 1,
  title: "My issue",
  html_url: "https://github.com/owner/repo/issues/1",
  state: "open",
  assignees: [{ login: "me" }],
};
const unrelated = {
  ...issue,
  number: 2,
  title: "Other issue",
  html_url: "https://github.com/owner/repo/issues/2",
  assignees: [],
};
const pull = {
  ...issue,
  number: 3,
  title: "My branch",
  html_url: "https://github.com/owner/repo/pull/3",
  assignees: [],
  head: { ref: "feat/current", repo: { full_name: "owner/repo" } },
};
const requests: string[] = [];
const deps: GithubDeps = {
  token: "fallback-test-token",
  run: async () => ({ code: 0, stdout: "gh-test-token\n", stderr: "" }),
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer gh-test-token");
    if (url.endsWith("/user")) return Response.json({ login: "me" });
    if (url.includes("/pulls?")) return Response.json([pull]);
    return Response.json([issue, unrelated, { ...pull, pull_request: {} }]);
  }) as typeof fetch,
};
const repos = [{ name: "owner/repo", branches: ["feat/current"], linked: [] }];

describe("PR CI status", () => {
  const sha = "a".repeat(40);
  const url = "https://github.com/owner/repo/pull/3";
  function ciDeps(
    runs: { status: string; conclusion: string | null }[],
    state = "pending",
    statusCount = 0,
  ): GithubDeps {
    return {
      ...deps,
      fetch: (async (input) =>
        String(input).includes("/check-runs")
          ? Response.json({ total_count: runs.length, check_runs: runs })
          : Response.json({ state, total_count: statusCount })) as typeof fetch,
    };
  }
  test("should combine check runs and legacy statuses without reporting absent checks as passing", async () => {
    expect((await readGithubCi("owner/repo", sha, url, "test", ciDeps([])))?.state).toBe("none");
    expect(
      (
        await readGithubCi(
          "owner/repo",
          sha,
          url,
          "test",
          ciDeps([{ status: "completed", conclusion: "success" }]),
        )
      )?.state,
    ).toBe("success");
    expect(
      (
        await readGithubCi(
          "owner/repo",
          sha,
          url,
          "test",
          ciDeps([{ status: "queued", conclusion: null }]),
        )
      )?.state,
    ).toBe("pending");
    expect(
      (
        await readGithubCi(
          "owner/repo",
          sha,
          url,
          "test",
          ciDeps([{ status: "completed", conclusion: "failure" }], "pending", 1),
        )
      )?.state,
    ).toBe("failure");
    expect(
      (
        await readGithubCi(
          "owner/repo",
          sha,
          url,
          "test",
          ciDeps([{ status: "completed", conclusion: "success" }], "failure", 1),
        )
      )?.state,
    ).toBe("failure");
    expect(
      (
        await readGithubCi(
          "owner/repo",
          sha,
          url,
          "test",
          ciDeps(
            [
              { status: "completed", conclusion: "neutral" },
              { status: "completed", conclusion: "skipped" },
            ],
            "pending",
            1,
          ),
        )
      )?.state,
    ).toBe("pending");
  });
  test("should fetch current PR head CI only when requested and keep PR links when checks are inaccessible", async () => {
    const paths: string[] = [];
    const fixture = {
      ...deps,
      fetch: (async (input) => {
        const path = String(input);
        paths.push(path);
        if (path.endsWith("/user")) return Response.json({ login: "me" });
        if (path.includes("/pulls?"))
          return Response.json([{ ...pull, head: { ...pull.head, sha } }]);
        if (path.includes("/commits/"))
          return new Response("private upstream diagnostic", { status: 403 });
        return Response.json([]);
      }) as typeof fetch,
    };
    const feed = await fetchGithubFeed(repos, "branches", fixture, true);
    expect(feed.items[0]?.ci).toBeNull();
    expect(feed.items[0]?.url).toBe(url);
    expect(paths.some((path) => path.includes(`/commits/${sha}/check-runs`))).toBe(true);
    expect(JSON.stringify(feed)).not.toContain("private upstream diagnostic");
    paths.length = 0;
    await fetchGithubFeed(repos, "branches", fixture);
    expect(paths.some((path) => path.includes("/commits/"))).toBe(false);
  });
  test("should paginate checks and refuse incomplete results", async () => {
    let pages = 0;
    const fixture = {
      ...deps,
      fetch: (async (input) => {
        if (String(input).endsWith("/status"))
          return Response.json({ state: "pending", total_count: 0 });
        pages++;
        return Response.json({
          total_count: 101,
          check_runs:
            pages === 1
              ? Array.from({ length: 100 }, () => ({ status: "completed", conclusion: "success" }))
              : [{ status: "completed", conclusion: "failure" }],
        });
      }) as typeof fetch,
    };
    expect((await readGithubCi("owner/repo", sha, url, "test", fixture))?.state).toBe("failure");
    expect(pages).toBe(2);
    const tooMany = {
      ...fixture,
      fetch: (async (_input: string | URL | Request) =>
        String(_input).endsWith("/status")
          ? Response.json({ state: "pending", total_count: 0 })
          : Response.json({ total_count: 501, check_runs: [] })) as typeof fetch,
    };
    expect(await readGithubCi("owner/repo", sha, url, "test", tooMany)).toBeNull();
  });
});

describe("GitHub authentication and relevant feed", () => {
  test("should accept only canonical GitHub remotes", () => {
    for (const remote of [
      "git@github.com:owner/repo.git",
      "https://github.com/owner/repo.git",
      "ssh://git@github.com/owner/repo",
    ])
      expect(githubRemote(remote)).toBe("owner/repo");
    expect(githubRemote("https://github.com.evil/owner/repo")).toBeNull();
    expect(githubRemote("https://token@github.com/owner/repo")).toBeNull();
  });
  test("should prefer gh and fall back to explicit config without exposing tokens in feed", async () => {
    expect((await githubAuth(deps)).source).toBe("gh");
    expect(
      (
        await githubAuth({
          ...deps,
          run: async () => {
            throw new Error("missing CLI");
          },
        })
      ).source,
    ).toBe("token");
    expect(
      (
        await githubAuth({
          ...deps,
          token: undefined,
          run: async () => ({ code: 1, stdout: "", stderr: "failed" }),
        })
      ).source,
    ).toBe("none");
    const feed = await fetchGithubFeed(repos, "relevant", deps);
    expect(feed.items.map((item) => item.number)).toEqual([1, 3]);
    expect(JSON.stringify(feed)).not.toContain("test-token");
  });
  test("should filter by assignee, current branch, and linked issue without duplicate PR issue entries", async () => {
    expect(
      (await fetchGithubFeed(repos, "assigned", deps)).items.map((item) => item.number),
    ).toEqual([1]);
    expect(
      (await fetchGithubFeed(repos, "branches", deps)).items.map((item) => item.number),
    ).toEqual([3]);
    expect(
      (
        await fetchGithubFeed(
          [
            {
              name: "owner/repo",
              branches: ["feat/current"],
              linked: [unrelated.html_url],
            },
          ],
          "relevant",
          deps,
        )
      ).items.map((item) => item.number),
    ).toEqual([1, 2, 3]);
    expect((await fetchGithubFeed(repos, "all", deps)).items.map((item) => item.number)).toEqual([
      1, 2, 3,
    ]);
  });
  test("should surface rate limit errors without upstream body or secret leakage", async () => {
    const rateLimited = {
      ...deps,
      fetch: (async (input: string | URL | Request) =>
        String(input).endsWith("/user")
          ? Response.json({ login: "me" })
          : new Response("secret-detail", { status: 403 })) as typeof fetch,
    };
    const feed = await fetchGithubFeed(repos, "all", rateLimited);
    expect(feed.errors[0]?.error).toContain("rate limit");
    expect(JSON.stringify(feed)).not.toContain("secret-detail");
  });
  test("should resolve GitHub token config and env", () => {
    expect(OrcConfigSchema.parse({}).github).toEqual({});
    const old = process.env.ORC_GITHUB_TOKEN;
    process.env.ORC_GITHUB_TOKEN = "config-test-token";
    resetConfig();
    expect(loadConfig().github.token).toBe("config-test-token");
    if (old === undefined) delete process.env.ORC_GITHUB_TOKEN;
    else process.env.ORC_GITHUB_TOKEN = old;
    resetConfig();
  });
  test("should include closing issues from current PR branches and reject same-named fork branches", async () => {
    const custom = {
      ...deps,
      fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/user")) return Response.json({ login: "me" });
        if (url.includes("/pulls?"))
          return Response.json([
            { ...pull, body: "Fixes #2" },
            {
              ...pull,
              number: 4,
              head: {
                ref: "feat/current",
                repo: { full_name: "outsider/repo" },
              },
            },
          ]);
        return Response.json([unrelated]);
      }) as typeof fetch,
    };
    expect(
      (await fetchGithubFeed(repos, "branches", custom)).items.map((item) => item.number),
    ).toEqual([2, 3]);
  });
});

describe("GitHub API boundary", () => {
  let app: ReturnType<typeof setupTestApp>;
  beforeAll(() => {
    app = setupTestApp();
  });
  afterAll(teardownTestApp);
  test("should require API auth and validate filters before external calls", async () => {
    expect((await app.request("/api/github/items")).status).toBe(401);
    expect((await req(app, "GET", "/github/items?filter=evil")).status).toBe(400);
  });
  test("should serve the authenticated feed through the API schema using the real filtering service", async () => {
    let project: string | undefined;
    const router = createGithubRouter(async (projectId, filter) => {
      project = projectId;
      return fetchGithubFeed(repos, filter, deps);
    });
    const isolated = new OpenAPIHono();
    isolated.use("*", bearerAuth("test-secret"));
    isolated.route("/api", router);
    const response = await isolated.request(
      "/api/github/items?project_id=project&filter=branches",
      { headers: { Authorization: "Bearer test-secret" } },
    );
    expect(response.status).toBe(200);
    expect(project).toBe("project");
    const raw = await response.text();
    const body = z
      .object({
        auth: z.string(),
        items: z.array(z.object({ number: z.number() })),
      })
      .parse(JSON.parse(raw));
    expect(body.auth).toBe("gh");
    expect(body.items.map((item: { number: number }) => item.number)).toEqual([3]);
    expect(raw).not.toContain("gh-test-token");
  });
});
