import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ScratchpadContentUrl } from "@orc/core/scratchpad";
import { SCRATCHPAD_CONTENT_MAX_BYTES, SCRATCHPAD_CONTENT_URL_TTL_MS } from "@orc/core/scratchpad";
import { getSqlite } from "@orc/db/client";
import { ScratchpadStore } from "@orc/db/scratchpads";
import { ScratchpadContentUrls } from "../scratchpad-content.js";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
let projectId: string;

beforeAll(async () => {
  app = setupTestApp();
  projectId = (await (await req(app, "POST", "/projects", { name: "pad-proj" })).json()).id;
});

afterAll(() => {
  teardownTestApp();
});

const create = async (body: Record<string, unknown>) => {
  const res = await req(app, "POST", "/scratchpads", body);
  expect(res.status).toBe(201);
  return res.json();
};

const contentUrl = async (id: string, mode: "download" | "upload", author?: string) => {
  const res = await req(app, "POST", `/scratchpads/${id}/content-url`, { mode, author });
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  return (await res.json()) as ScratchpadContentUrl;
};

describe("Scratchpads REST API", () => {
  test("should create, read, update and delete a pad with api as the default author", async () => {
    const pad = await create({ kind: "doc", title: "Plan", project_id: projectId, tags: ["a"] });
    expect(pad).toMatchObject({ kind: "doc", author: "api", revision: 1, project_id: projectId });

    const read = await req(app, "GET", `/scratchpads/${pad.id}`);
    expect(await read.json()).toMatchObject({ id: pad.id, content: "" });

    const updated = await req(app, "PATCH", `/scratchpads/${pad.id}`, {
      content: "# Plan\n\n```mermaid\ngraph TD; a-->b\n```",
      if_revision: 1,
      author: "human",
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ revision: 2, author: "human" });

    expect((await req(app, "DELETE", `/scratchpads/${pad.id}`)).status).toBe(204);
    expect((await req(app, "GET", `/scratchpads/${pad.id}`)).status).toBe(404);
    expect((await req(app, "DELETE", `/scratchpads/${pad.id}`)).status).toBe(404);
  });

  test("should return 409 for a stale if_revision and 400 for bad diagram content", async () => {
    const pad = await create({ kind: "diagram", title: "Arch" });
    await req(app, "PATCH", `/scratchpads/${pad.id}`, { title: "Arch v2" });
    const stale = await req(app, "PATCH", `/scratchpads/${pad.id}`, {
      content: pad.content,
      if_revision: 1,
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toContain("revision 2 by api, expected 1");

    const bad = await req(app, "PATCH", `/scratchpads/${pad.id}`, { content: "graph TD" });
    expect(bad.status).toBe(400);
    const unknownField = await req(app, "PATCH", `/scratchpads/${pad.id}`, { revision: 9 });
    expect(unknownField.status).toBe(400);
  });

  test("should list without content and filter by kind, project, unassigned, session and tag", async () => {
    const html = await create({
      kind: "html",
      title: "Chart",
      session_id: "native-9",
      tags: ["viz"],
    });
    const linked = await create({ kind: "doc", title: "Linked", project_id: projectId });

    const all = await (await req(app, "GET", "/scratchpads")).json();
    expect(all.total).toBeGreaterThanOrEqual(2);
    expect(all.scratchpads[0]).not.toHaveProperty("content");
    expect(all.scratchpads[0]).toHaveProperty("size_bytes");

    const ids = async (query: string) =>
      (await (await req(app, "GET", `/scratchpads?${query}`)).json()).scratchpads.map(
        (pad: { id: string }) => pad.id,
      );
    expect(await ids("kind=html")).toContain(html.id);
    expect(await ids("kind=html")).not.toContain(linked.id);
    expect(await ids(`project_id=${projectId}`)).toContain(linked.id);
    expect(await ids(`project_id=${projectId}`)).not.toContain(html.id);
    expect(await ids("unassigned=true")).toContain(html.id);
    expect(await ids("unassigned=true")).not.toContain(linked.id);
    expect(await ids("session_id=native-9")).toEqual([html.id]);
    expect(await ids("tag=viz")).toEqual([html.id]);
    expect(await ids("limit=1")).toHaveLength(1);
  });

  test("should round-trip the raw file through signed URLs without the API secret", async () => {
    const pad = await create({ kind: "html", title: "Dash board", session_id: "origin" });
    const page = "<!doctype html><h1>héllo</h1>";

    const upload = await contentUrl(pad.id, "upload", "agent/claude");
    expect(upload).toMatchObject({ filename: "dash-board.html", revision: 1 });
    expect(upload.download_url).toBeUndefined();
    const put = await app.request(upload.upload_url as string, { method: "PUT", body: page });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({
      id: pad.id,
      revision: 2,
      size_bytes: Buffer.byteLength(page),
    });

    const stored = await (await req(app, "GET", `/scratchpads/${pad.id}`)).json();
    // The writer is recorded; the pad's origin-session link is untouched.
    expect(stored).toMatchObject({ content: page, author: "agent/claude", session_id: "origin" });

    // A replayed upload finds the pad past its revision.
    const replay = await app.request(upload.upload_url as string, { method: "PUT", body: "x" });
    expect(replay.status).toBe(409);

    const download = await contentUrl(pad.id, "download");
    const get = await app.request(download.download_url as string);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe(page);
    expect(get.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(get.headers.get("Content-Disposition")).toContain("dash-board.html");
    expect(get.headers.get("X-Scratchpad-Revision")).toBe("2");
    expect(get.headers.get("Content-Security-Policy")).toBe("sandbox");
  });

  test("should refuse forged, cross-mode and oversized content requests", async () => {
    const pad = await create({ kind: "doc", title: "Guarded" });
    const download = await contentUrl(pad.id, "download");
    const token = (download.download_url as string).split("/").at(-1) as string;
    const [payload] = token.split(".");

    const forged = await app.request(`/api/scratchpads/content/${payload}.${"A".repeat(43)}`);
    expect(forged.status).toBe(401);
    const crossMode = await app.request(download.download_url as string, {
      method: "PUT",
      body: "x",
    });
    expect(crossMode.status).toBe(400);

    const upload = await contentUrl(pad.id, "upload");
    const huge = await app.request(upload.upload_url as string, {
      method: "PUT",
      body: "x".repeat(SCRATCHPAD_CONTENT_MAX_BYTES + 1),
    });
    expect(huge.status).toBe(413);
    expect((await req(app, "GET", `/scratchpads/${pad.id}`)).status).toBe(200);
  });

  test("should keep every other scratchpad route behind the API secret", async () => {
    const pad = await create({ kind: "doc", title: "Private" });
    for (const [method, path] of [
      ["GET", "/api/scratchpads"],
      ["GET", `/api/scratchpads/${pad.id}`],
      ["POST", `/api/scratchpads/${pad.id}/content-url`],
      ["DELETE", `/api/scratchpads/${pad.id}`],
      ["GET", "/api/scratchpads/content/not-a-token"],
    ] as const)
      expect((await app.request(path, { method })).status).toBe(401);
  });

  test("should expire content URLs", () => {
    const store = new ScratchpadStore(getSqlite());
    const pad = store.create({ kind: "doc", title: "Clock" });
    let now = 1_000;
    const urls = new ScratchpadContentUrls(() => now);
    const url = urls.mint(pad, "download", "http://orc.test", "api").download_url as string;
    const token = url.split("/").at(-1) as string;
    expect(urls.verify(token, "download").id).toBe(pad.id);
    now += SCRATCHPAD_CONTENT_URL_TTL_MS;
    expect(() => urls.verify(token, "download")).toThrow();
  });
});
