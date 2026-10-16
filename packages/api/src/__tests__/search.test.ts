import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getSqlite } from "@orc/db/client";
import { WikiStore } from "@orc/db/wiki";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  app = setupTestApp();
  let projectId = "";
  for (const name of ["palette-one", "palette-two"]) {
    const project = await (await req(app, "POST", "/projects", { name })).json();
    projectId = project.id;
    await req(app, "POST", "/tasks", {
      title: `Needle ${name}`,
      body: "body-only-match",
      project_id: project.id,
    });
  }
  await req(app, "POST", "/tasks", { title: "literal %_ match" });
  await req(app, "POST", "/memories", {
    project_id: projectId,
    name: "needle-memory",
    description: "Needle memory",
    content: "memory content",
  });
  new WikiStore(getSqlite()).write({
    project_id: null,
    slug: "needle-wiki",
    kind: "concept",
    title: "Needle wiki",
    summary: "Wiki result",
    content: "body-only-wiki",
    expected_revision: 0,
    note: "fixture",
  });
});
afterAll(teardownTestApp);

describe("global command search", () => {
  test("searches across projects and resource types, including bodies", async () => {
    const { results } = await (await req(app, "GET", "/search?q=needle")).json();
    expect(results.filter((r: { kind: string }) => r.kind === "task")).toHaveLength(2);
    expect(results.map((r: { kind: string }) => r.kind)).toContain("memory");
    expect(results.map((r: { kind: string }) => r.kind)).toContain("wiki");
    const bodies = await (await req(app, "GET", "/search?q=body-only-match")).json();
    expect(bodies.results).toHaveLength(2);
  });
  test("scopes explicitly and bounds each category", async () => {
    const { results } = await (await req(app, "GET", "/search?q=needle&limit=1")).json();
    expect(results.filter((r: { kind: string }) => r.kind === "task")).toHaveLength(1);
    const id = results.find((r: { kind: string }) => r.kind === "task").project_id;
    const scoped = await (await req(app, "GET", `/search?q=needle&project_id=${id}`)).json();
    expect(scoped.results.every((r: { project_id: string }) => r.project_id === id)).toBe(true);
    const unassigned = await (
      await req(app, "GET", "/search?q=needle&project_id=unassigned")
    ).json();
    expect(
      unassigned.results.every((r: { project_id: string | null }) => r.project_id === null),
    ).toBe(true);
  });
  test("treats wildcards and SQL-looking text literally", async () => {
    const wildcards = await (await req(app, "GET", "/search?q=%25_")).json();
    expect(wildcards.results).toHaveLength(1);
    expect(wildcards.results[0].title).toBe("literal %_ match");
    const injection = await (
      await req(app, "GET", `/search?q=${encodeURIComponent("' OR 1=1 --")}`)
    ).json();
    expect(injection.results).toEqual([]);
  });
  test("validates query and requires API authentication", async () => {
    for (const query of ["", "?q=", "?q=x&limit=21", `?q=${"a".repeat(201)}`])
      expect((await req(app, "GET", `/search${query}`)).status).toBe(400);
    expect((await app.request("/api/search?q=needle")).status).toBe(401);
  });
});
