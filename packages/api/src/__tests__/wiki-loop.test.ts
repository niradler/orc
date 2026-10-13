import { afterEach, beforeEach, expect, test } from "bun:test";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof setupTestApp>;
beforeEach(() => {
  app = setupTestApp();
});
afterEach(teardownTestApp);
const page = {
  project_id: null,
  slug: "verified-port",
  kind: "procedure",
  title: "Verified port procedure",
  summary: "Check the active source API before generating contracts",
  content: "Use the isolated source API on 7711.",
  expected_revision: 0,
  note: "Verified locally",
  sources: ["session:review"],
  author: "codex",
  session_id: "review",
};

test("should save, reload, reject stale revisions, retain history and audit the write", async () => {
  expect((await req(app, "POST", "/wiki", page)).status).toBe(201);
  expect((await req(app, "POST", "/wiki", page)).status).toBe(409);
  expect(
    (
      await req(app, "POST", "/wiki", {
        ...page,
        expected_revision: 1,
        content: "Reloaded and verified",
        note: "Refined",
      })
    ).status,
  ).toBe(200);
  expect(await (await req(app, "GET", "/wiki/verified-port")).json()).toMatchObject({
    revision: 2,
    content: "Reloaded and verified",
  });
  const history = await (await req(app, "GET", "/wiki/verified-port/history")).json();
  expect(history.revisions.map((r: { revision: number }) => r.revision)).toEqual([2, 1]);
  expect(history.revisions[1]).toMatchObject({ content: page.content, session_id: "review" });
  const audit = await (await req(app, "GET", "/audit?entity_type=wiki&session_id=review")).json();
  expect(audit.entries.map((e: { action: string }) => e.action)).toEqual([
    "wiki.updated",
    "wiki.created",
  ]);
  expect(audit.entries[0].snapshot).toEqual({ revision: 2 });
  const index = await (await req(app, "GET", "/wiki")).json();
  expect(index.pages[0]).not.toHaveProperty("content");
});

test("should isolate projects, shadow global slugs and allow explicit global history", async () => {
  const p1 = await (await req(app, "POST", "/projects", { name: "wiki-one" })).json();
  const p2 = await (await req(app, "POST", "/projects", { name: "wiki-two" })).json();
  await req(app, "POST", "/wiki", page);
  await req(app, "POST", "/wiki", {
    ...page,
    project_id: p1.id,
    summary: "Project-specific procedure",
    content: "Project-specific content",
  });
  const own = await (await req(app, "GET", `/wiki?project_id=${p1.id}`)).json();
  expect(own.pages).toHaveLength(1);
  expect(own.pages[0].project_id).toBe(p1.id);
  const fallback = await (await req(app, "GET", `/wiki/verified-port?project_id=${p2.id}`)).json();
  expect(fallback.project_id).toBeNull();
  const global = await (
    await req(app, "GET", `/wiki/verified-port/history?project_id=${p1.id}&scope=global`)
  ).json();
  expect(global.revisions[0].content).toBe(page.content);
  expect((await req(app, "GET", "/wiki?project_id=missing")).status).toBe(404);
  expect((await req(app, "POST", "/wiki", { ...page, project_id: "missing" })).status).toBe(404);
  const search = await (
    await req(app, "GET", `/wiki/search?q=Project-specific&project_id=${p1.id}`)
  ).json();
  expect(search.results[0].project_id).toBe(p1.id);
  const isolated = await (
    await req(app, "GET", `/audit?project_id=${p2.id}&entity_type=wiki`)
  ).json();
  expect(isolated.entries).toEqual([]);
});

test("should protect wiki and audit reads/writes and validate inputs", async () => {
  for (const path of [
    "/api/wiki",
    "/api/wiki/changes",
    "/api/wiki/verified-port/history",
    "/api/audit",
  ]) {
    expect((await app.request(path)).status).toBe(401);
  }
  expect(
    (
      await app.request("/api/wiki", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(page),
      })
    ).status,
  ).toBe(401);
  expect((await req(app, "POST", "/wiki", { ...page, slug: "../../unsafe" })).status).toBe(400);
  expect((await req(app, "GET", "/audit?limit=101")).status).toBe(400);
});

test("should use agent tools to write and read pages through authenticated HTTP", async () => {
  const call = (name: string, args: unknown) => req(app, "POST", "/mcp/tool", { name, args });
  const { project_id: _unused, ...input } = page;
  expect((await call("wiki_write", { ...input, scope: "global" })).status).toBe(200);
  const read = await (await call("wiki_get", { slug: page.slug, scope: "global" })).json();
  expect(JSON.parse(read.result)).toMatchObject({ content: page.content, revision: 1 });
  const index = await (await call("wiki_index", { scope: "global" })).json();
  expect(JSON.parse(index.result).pages[0]).not.toHaveProperty("content");
});
