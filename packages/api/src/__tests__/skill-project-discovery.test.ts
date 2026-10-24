import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getSqlite } from "@orc/db/client";
import { SkillHistory } from "@orc/db/skill-history";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
let history: SkillHistory;
beforeAll(() => {
  app = setupTestApp();
  getSqlite().exec(
    "INSERT INTO projects(id,name) VALUES ('skills-one','skills-one'),('skills-two','skills-two'),('skills-three','skills-three')",
  );
  history = new SkillHistory(getSqlite());
});
beforeEach(() => {
  history.setProjects("orc-sdlc", []);
  history.setProjects("orc-platform", []);
});
afterAll(teardownTestApp);

async function rpc(query: string, name: string, args: Record<string, unknown> = {}) {
  const response = await app.request(`/mcp${query}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer test-secret",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await response.text();
  const data = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  return { response, data, text: data.result?.content?.[0]?.text as string | undefined };
}

describe("project-scoped skill discovery", () => {
  test("should manage multiple assignments and reject unknown projects atomically", async () => {
    const assigned = await req(app, "PUT", "/skills/orc-sdlc/projects", {
      project_ids: ["skills-one", "skills-two"],
    });
    expect(assigned.status).toBe(200);
    expect((await assigned.json()).project_ids).toEqual(["skills-one", "skills-two"]);
    const invalid = await req(app, "PUT", "/skills/orc-sdlc/projects", {
      project_ids: ["missing"],
    });
    expect(invalid.status).toBe(404);
    expect((await (await req(app, "GET", "/skills/orc-sdlc/projects")).json()).project_ids).toEqual(
      ["skills-one", "skills-two"],
    );
    expect(
      (await req(app, "PUT", "/skills/orc-sdlc/projects", { project_ids: "skills-one" })).status,
    ).toBe(400);
  });

  test("should filter before counts, pagination and search and preserve global skills", async () => {
    history.setProjects("orc-sdlc", ["skills-two"]);
    const page = await (
      await req(app, "GET", "/skills?source=builtin&project_id=skills-one&limit=1")
    ).json();
    expect(page.skills.map((s: { name: string }) => s.name)).toEqual(["orc-platform"]);
    expect(page.total).toBe(1);
    expect(page.next_offset).toBeNull();
    const search = await (await req(app, "GET", "/skills?q=sdlc&project_id=skills-one")).json();
    expect(search.skills).toEqual([]);
    expect((await req(app, "GET", "/skills/orc-sdlc?project_id=skills-one")).status).toBe(404);
    expect((await req(app, "GET", "/skills/orc-sdlc?project_id=skills-two")).status).toBe(200);
    expect((await req(app, "GET", "/skills/orc-sdlc")).status).toBe(404);
  });

  test("should require reassignment before deleting a project with assigned skills", async () => {
    history.setProjects("orc-sdlc", ["skills-two"]);
    const response = await req(app, "DELETE", "/projects/skills-two");
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("reassign");
    expect(history.projectIds("orc-sdlc")).toEqual(["skills-two"]);
  });

  test("should paginate lists and search with relevance scores and stable ties", async () => {
    for (const q of ["", "&q=orc"]) {
      const path = `/skills?source=builtin&limit=1${q}`;
      const first = await (await req(app, "GET", path)).json();
      const second = await (await req(app, "GET", `${path}&offset=${first.next_offset}`)).json();
      expect(first.total).toBe(2);
      expect(first.offset).toBe(0);
      expect(first.limit).toBe(1);
      expect(first.next_offset).toBe(1);
      expect(second.next_offset).toBeNull();
      expect(second.skills[0].name).not.toBe(first.skills[0].name);
      if (q) expect(first.skills[0].score).toBeGreaterThanOrEqual(second.skills[0].score);
      const beyond = await (await req(app, "GET", `${path}&offset=1000`)).json();
      expect(beyond.skills).toEqual([]);
      expect(beyond.total).toBe(2);
    }
    for (const suffix of ["offset=-1", "limit=501", "offset=1.5"])
      expect((await req(app, "GET", `/skills?${suffix}`)).status).toBe(400);
  });

  test("should bind HTTP MCP project in both full and meta invocation", async () => {
    history.setProjects("orc-sdlc", ["skills-one", "skills-three"]);
    history.setProjects("orc-platform", ["skills-two"]);
    for (const mode of ["full", "meta"]) {
      const query = `?project=skills-one&mode=${mode}`;
      const call = (name: string, args: Record<string, unknown> = {}) =>
        mode === "meta"
          ? rpc(query, "tool_invoke", { name, arguments: args })
          : rpc(query, name, args);
      const list = await call("skill_list");
      expect(list.text).toContain("orc-sdlc");
      expect(list.text).not.toContain("orc-platform");
      expect(list.text).toContain("next_offset=null");
      const read = await call("skill_read", { name: "orc-sdlc" });
      expect(read.text).toContain("# orc-sdlc");
      for (const args of [
        { name: "orc-platform" },
        { name: "orc-platform", ref: "SKILL.md" },
        { name: "orc-memory", ref: "references/work.md" },
        { name: "orc-platform", download: true, ref: "SKILL.md" },
      ])
        expect((await call("skill_read", args)).text).toContain("Skill not found");
      expect((await call("skill_list", { project: "skills-two" })).data.result.isError).toBe(true);
      const globals = await call("skill_list", { source: "builtin", scope: "global" });
      expect(globals.text).toContain("No skills found");
      expect(globals.data.result.isError).not.toBe(true);
      expect((await call("skill_read", { name: "orc-platform", scope: "global" })).text).toContain(
        "Skill not found",
      );
    }
  });

  test("should reject unknown or empty endpoint projects and require auth", async () => {
    expect((await rpc("?project=missing", "skill_list")).response.status).toBe(404);
    expect((await rpc("?project=", "skill_list")).response.status).toBe(400);
    const noAuth = await app.request("/mcp?project=skills-one", { method: "POST" });
    expect(noAuth.status).toBe(401);
    const restNoAuth = await app.request("/api/skills/orc-sdlc/projects", { method: "PUT" });
    expect(restNoAuth.status).toBe(401);
  });

  test("should keep refs, aliases, downloads and history unavailable outside their projects", async () => {
    history.setProjects("orc-platform", ["skills-two"]);
    for (const name of ["orc-platform", "orc-memory"]) {
      expect(
        (await req(app, "GET", `/skills/${name}?project_id=skills-one&ref=SKILL.md`)).status,
      ).toBe(404);
      expect(
        (
          await req(app, "POST", `/skills/${name}/download`, {
            ref: "SKILL.md",
            project_id: "skills-one",
          })
        ).status,
      ).toBe(404);
    }
    expect(
      (await req(app, "GET", "/skills/orc-platform/history?project_id=skills-one")).status,
    ).toBe(404);
    const own = await req(app, "POST", "/skills/orc-platform/download", {
      ref: "SKILL.md",
      project_id: "skills-two",
    });
    expect(own.status).toBe(200);
    const url = new URL((await own.json()).download_url);
    history.setProjects("orc-platform", ["skills-three"]);
    expect((await app.request(url.pathname)).status).toBe(404);
  });
});
