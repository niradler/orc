import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  app = setupTestApp();
});

afterAll(() => {
  teardownTestApp();
});

describe("Projects CRUD", () => {
  let projectId: string;

  test("should persist an optional Git remote, retain omitted values, and clear with blank or null", async () => {
    const created = await req(app, "POST", "/projects", {
      name: "git-remote-config",
      git_remote_url: "  https://github.com/acme/project.git  ",
    });
    expect(created.status).toBe(201);
    const project = await created.json();
    expect(project.git_remote_url).toBe("https://github.com/acme/project.git");
    const updated = await req(app, "PATCH", `/projects/${project.id}`, {
      description: "Preserve remote",
    });
    expect((await updated.json()).git_remote_url).toBe(project.git_remote_url);
    for (const path of [`/projects/${project.id}`, "/projects/by-name/git-remote-config"]) {
      expect((await (await req(app, "GET", path)).json()).git_remote_url).toBe(
        project.git_remote_url,
      );
    }
    expect(
      (await (await req(app, "GET", `/projects/${project.id}/summary`)).json()).project
        .git_remote_url,
    ).toBe(project.git_remote_url);
    expect(
      (await (await req(app, "GET", "/projects")).json()).projects.find(
        (entry: { id: string }) => entry.id === project.id,
      ).git_remote_url,
    ).toBe(project.git_remote_url);
    for (const remote of [
      "git@github.com:acme/project.git",
      "ssh://git@git.example.com:2222/team/repo.git",
      "http://git.local/team/repo",
      "git://git.example.com/repo",
    ]) {
      const response = await req(app, "PATCH", `/projects/${project.id}`, {
        git_remote_url: remote,
      });
      expect(response.status).toBe(200);
      expect((await response.json()).git_remote_url).toBe(remote);
    }
    for (const value of ["", "   ", null]) {
      expect(
        (
          await (
            await req(app, "PATCH", `/projects/${project.id}`, { git_remote_url: value })
          ).json()
        ).git_remote_url,
      ).toBeNull();
    }
    const optional = await req(app, "POST", "/projects", { name: "git-remote-omitted" });
    expect((await optional.json()).git_remote_url).toBeNull();
  });

  test("should protect remote writes and reject unsafe URLs without echoing credentials", async () => {
    expect(
      (
        await app.request("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "unauthorized-remote",
            git_remote_url: "https://git.example.com/repo",
          }),
        })
      ).status,
    ).toBe(401);
    for (const remote of [
      "not a URL",
      "javascript:alert(1)",
      "file:///private/repo",
      "https://user:s3cr3t-token@git.example.com/repo",
      "https://s3cr3t-token@git.example.com/repo",
      "ssh://git:s3cr3t-token@git.example.com/repo",
      "https://git.example.com/repo?token=s3cr3t-token",
      "https://git.example.com/repo#s3cr3t-token",
      "git@host:repo\ncommand",
      `https://git.example.com/${"a".repeat(2048)}`,
    ]) {
      const response = await req(app, "POST", "/projects", {
        name: "unsafe-remote",
        git_remote_url: remote,
      });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("s3cr3t-token");
    }
  });

  describe("POST /projects", () => {
    test("creates a project with minimal fields", async () => {
      const res = await req(app, "POST", "/projects", { name: "test-proj" });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe("test-proj");
      expect(body.status).toBe("active");
      expect(body.id).toBeTruthy();
      projectId = body.id;
    });

    test("creates a project with all fields", async () => {
      const res = await req(app, "POST", "/projects", {
        name: "full-proj",
        description: "A full project",
        status: "paused",
        scope: "backend services",
        tags: ["infra", "api"],
        obsidian_path: "/vault/projects/full-proj",
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe("full-proj");
      expect(body.description).toBe("A full project");
      expect(body.status).toBe("paused");
      expect(body.scope).toBe("backend services");
      expect(body.tags).toEqual(["infra", "api"]);
      expect(body.obsidian_path).toBe("/vault/projects/full-proj");
    });

    test("rejects invalid project name", async () => {
      const res = await req(app, "POST", "/projects", { name: "bad name!" });
      expect(res.status).toBe(400);
    });

    test("rejects empty name", async () => {
      const res = await req(app, "POST", "/projects", { name: "" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /projects", () => {
    test("lists all projects", async () => {
      const res = await req(app, "GET", "/projects");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.projects.length).toBeGreaterThanOrEqual(2);
    });

    test("filters by status", async () => {
      const res = await req(app, "GET", "/projects?status=paused");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.projects.length).toBeGreaterThanOrEqual(1);
      for (const p of body.projects) {
        expect(p.status).toBe("paused");
      }
    });

    test("respects limit", async () => {
      const res = await req(app, "GET", "/projects?limit=1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.projects.length).toBeLessThanOrEqual(1);
    });
  });

  describe("GET /projects/:id", () => {
    test("returns a project by ID", async () => {
      const res = await req(app, "GET", `/projects/${projectId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(projectId);
      expect(body.name).toBe("test-proj");
    });

    test("returns 404 for non-existent project", async () => {
      const res = await req(app, "GET", "/projects/nonexistent-id");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /projects/by-name/:name", () => {
    test("finds project by exact name", async () => {
      const res = await req(app, "GET", "/projects/by-name/test-proj");
      expect(res.status).toBe(200);
    });

    test("returns 404 for non-existent name", async () => {
      const res = await req(app, "GET", "/projects/by-name/no-such-project");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /projects/:id/summary", () => {
    test("returns project summary with counts", async () => {
      await req(app, "POST", "/tasks", {
        title: "Summary task",
        project_id: projectId,
      });
      const memory = await req(app, "POST", "/memories", {
        project_id: projectId,
        name: "summary-memory",
        description: "Summary memory",
        content: "Counted in the project summary",
      });
      expect(memory.status).toBe(201);

      const res = await req(app, "GET", `/projects/${projectId}/summary`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.project.id).toBe(projectId);
      expect(body.tasks.total).toBeGreaterThanOrEqual(1);
      expect(body.memories).toBe(1);
      expect(typeof body.jobs).toBe("number");
    });

    test("returns 404 for non-existent project", async () => {
      const res = await req(app, "GET", "/projects/nonexistent-id/summary");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /projects/:id", () => {
    test("updates name", async () => {
      const res = await req(app, "PATCH", `/projects/${projectId}`, {
        name: "renamed-proj",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("renamed-proj");
    });

    test("updates description", async () => {
      const res = await req(app, "PATCH", `/projects/${projectId}`, {
        description: "Updated description",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.description).toBe("Updated description");
    });

    test("updates status", async () => {
      const res = await req(app, "PATCH", `/projects/${projectId}`, {
        status: "archived",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("archived");
    });

    test("updates tags", async () => {
      const res = await req(app, "PATCH", `/projects/${projectId}`, {
        tags: ["updated"],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tags).toEqual(["updated"]);
    });

    test("updates scope", async () => {
      const res = await req(app, "PATCH", `/projects/${projectId}`, {
        scope: "new scope",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.scope).toBe("new scope");
    });

    test("returns 404 for non-existent project", async () => {
      const res = await req(app, "PATCH", "/projects/nonexistent-id", {
        name: "x",
      });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /projects/:id", () => {
    test("deletes a project", async () => {
      const createRes = await req(app, "POST", "/projects", {
        name: "to-delete",
      });
      const created = await createRes.json();

      const res = await req(app, "DELETE", `/projects/${created.id}`);
      expect(res.status).toBe(204);

      const getRes = await req(app, "GET", `/projects/${created.id}`);
      expect(getRes.status).toBe(404);
    });

    test("returns 404 for non-existent project", async () => {
      const res = await req(app, "DELETE", "/projects/nonexistent-id");
      expect(res.status).toBe(404);
    });
  });
});

test("should paginate beyond 100 projects with stable ordering, filters and validated page bounds", async () => {
  const expected: string[] = [];
  for (let index = 0; index < 105; index++) {
    const response = await req(app, "POST", "/projects", {
      name: `pagination-${String(index).padStart(3, "0")}`,
      tags: ["pagination-regression"],
      status: index % 2 === 0 ? "active" : "archived",
    });
    expect(response.status).toBe(201);
    expected.push((await response.json()).id);
  }
  type Page = {
    projects: { id: string }[];
    offset: number;
    limit: number;
    next_offset: number | null;
  };
  const read = async (query: string): Promise<Page> => {
    const response = await req(app, "GET", `/projects?${query}`);
    expect(response.status).toBe(200);
    return response.json();
  };
  const first = await read("tag=pagination-regression");
  expect(first.projects).toHaveLength(50);
  expect(first.next_offset).toBe(50);
  const ids: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await read(`tag=pagination-regression&limit=25&offset=${offset}`);
    expect(page.offset).toBe(offset);
    expect(page.limit).toBe(25);
    ids.push(...page.projects.map((project) => project.id));
    offset = page.next_offset;
  }
  expect(ids).toEqual(expected);
  const active = await read("tag=pagination-regression&status=active&limit=100");
  expect(active.projects.map((project) => project.id)).toEqual(
    expected.filter((_, i) => i % 2 === 0),
  );
  expect(active.next_offset).toBeNull();
  const all: string[] = [];
  offset = 0;
  while (offset !== null) {
    const page = await read(`limit=17&offset=${offset}`);
    all.push(...page.projects.map((project) => project.id));
    offset = page.next_offset;
  }
  expect(all.filter((id) => expected.includes(id))).toEqual(expected);
  expect(new Set(all).size).toBe(all.length);
  expect((await read("tag=pagination-regression&offset=105")).projects).toEqual([]);
  for (const query of [
    "offset=-1",
    "offset=1.5",
    "offset=invalid",
    "offset=9007199254740992",
    "limit=101",
  ])
    expect((await req(app, "GET", `/projects?${query}`)).status).toBe(400);
  expect((await app.request("/api/projects?offset=50")).status).toBe(401);
});
