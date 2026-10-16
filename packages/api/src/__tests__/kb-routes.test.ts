import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalConfigPath, loadConfig, resetConfig } from "@orc/core/config";
import { getDb } from "@orc/db/client";
import { closeKnowledgeService, getKnowledgeService } from "@orc/knowledge";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

const ENV = ["ORC_KNOWLEDGE_ROOT", "HOME", "USERPROFILE"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let app: ReturnType<typeof createApp>;
let home: string;

/** An agent call: the MCP source, which is what KB permissions look at. */
const agent = { "X-Orc-Source": "mcp", "X-Orc-Session-Id": "sess-api-1" };

/** Request with transport/identity headers; JSON or multipart body. */
async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const form = body instanceof FormData;
  const res = await app.request(`/api${path}`, {
    method,
    headers: {
      Authorization: "Bearer test-secret",
      ...(form || body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
  });
  return res as Awaited<ReturnType<typeof req>>;
}

const idle = async () => (await getKnowledgeService()).jobs.idle();

beforeAll(() => {
  // Settings writes go to ~/.orc/config.json: keep them in a throwaway home.
  home = mkdtempSync(join(tmpdir(), "orc-api-kb-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ORC_KNOWLEDGE_ROOT = join(home, "knowledge");
  app = setupTestApp();
});

afterAll(async () => {
  await closeKnowledgeService();
  teardownTestApp();
  for (const k of ENV)
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  resetConfig();
  rmSync(home, { recursive: true, force: true });
});

describe("/api/kb", () => {
  let projectId: string;
  let kbId: string;
  let learnId: string;
  let docId: string;

  test("creates project and global KBs; names are unique per scope; MCP cannot create", async () => {
    projectId = (await (await req(app, "POST", "/projects", { name: "kb-proj" })).json()).id;
    const res = await call("POST", "/kb/bases", {
      name: "Runbooks",
      project_id: projectId,
      editable_by: ["ui", "cli", "api"],
    });
    expect(res.status).toBe(201);
    kbId = (await res.json()).id;
    const learn = await call("POST", "/kb/bases", {
      name: "Learned",
      project_id: null,
    });
    learnId = (await learn.json()).id;

    expect(
      (await call("POST", "/kb/bases", { name: "Runbooks", project_id: projectId })).status,
    ).toBe(409);
    expect((await call("POST", "/kb/bases", { name: "X", project_id: null }, agent)).status).toBe(
      403,
    );
    expect((await call("POST", "/kb/bases", { name: "X" })).status).toBe(400);

    const scoped = await (await call("GET", `/kb/bases?project_id=${projectId}`)).json();
    expect(scoped.knowledge_bases.map((k: { id: string }) => k.id).sort()).toEqual(
      [kbId, learnId].sort(),
    );
    const global = await (await call("GET", "/kb/bases")).json();
    expect(global.knowledge_bases.map((k: { id: string }) => k.id)).toEqual([learnId]);
  });

  test("project deletion refuses while it owns a KB", async () => {
    const res = await req(app, "DELETE", `/projects/${projectId}`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("1 knowledge base");
  });

  test("project deletion clears references from the legacy knowledge_collections table", async () => {
    const project = await (await req(app, "POST", "/projects", { name: "legacy-kb-owner" })).json();
    const sqlite = (getDb() as unknown as { $client: Database }).$client;
    sqlite.run(
      "CREATE TABLE knowledge_collections (name TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id))",
    );
    try {
      sqlite.run("INSERT INTO knowledge_collections (name, project_id) VALUES ('old', ?)", [
        project.id,
      ]);
      expect((await req(app, "DELETE", `/projects/${project.id}`)).status).toBe(204);
      expect(sqlite.query("SELECT name, project_id FROM knowledge_collections").all()).toEqual([
        { name: "old", project_id: null },
      ]);
    } finally {
      sqlite.run("DROP TABLE knowledge_collections");
    }
  });

  test("documents: create, list by folder, section read, optimistic update, revisions", async () => {
    const res = await call("POST", `/kb/bases/${kbId}/documents`, {
      title: "Rotate signing key",
      path: "security/rotate-key.md",
      labels: ["security"],
      content:
        "# Rotate signing key\n\n## Steps\n\nRun vault rotate.\n\n## Rollback\n\nRestore the backup key.",
    });
    expect(res.status).toBe(201);
    const doc = await res.json();
    docId = doc.id;
    expect(doc.revision).toBe(1);
    await idle();

    const list = await (await call("GET", `/kb/bases/${kbId}/documents?folder=security`)).json();
    expect(list.documents.map((d: { id: string }) => d.id)).toEqual([docId]);

    const section = await (
      await call("GET", `/kb/documents/${docId}?heading=Rollback`, undefined, {
        "X-Orc-Source": "ui",
      })
    ).json();
    expect(section.content).toContain("Restore the backup key");
    expect(section.content).not.toContain("vault rotate");

    const upd = await call("PATCH", `/kb/documents/${docId}`, {
      expected_revision: 1,
      content:
        "# Rotate signing key\n\n## Steps\n\nRun vault rotate --force.\n\n## Rollback\n\nRestore the backup key.",
      note: "force flag",
    });
    expect((await upd.json()).revision).toBe(2);
    const stale = await call("PATCH", `/kb/documents/${docId}`, {
      expected_revision: 1,
      title: "Nope",
    });
    expect(stale.status).toBe(409);

    const revs = await (await call("GET", `/kb/documents/${docId}/revisions`)).json();
    expect(revs.revisions.map((r: { revision: number }) => r.revision).sort()).toEqual([1, 2]);
    const r1 = await (await call("GET", `/kb/documents/${docId}/revisions/1`)).json();
    expect(r1.content).toContain("Run vault rotate.");
  });

  test("a KB refuses edits from sources outside editable_by", async () => {
    const res = await call(
      "PATCH",
      `/kb/documents/${docId}`,
      { expected_revision: 2, title: "x" },
      agent,
    );
    expect(res.status).toBe(403);
  });

  test("upload: markdown becomes a document and other formats keep a downloadable original", async () => {
    const form = new FormData();
    form.set("file", new File(["# Gateway\n\nRestart the gateway after rotation."], "gateway.md"));
    form.set("labels", "ops, gateway");
    const res = await call("POST", `/kb/bases/${kbId}/upload`, form);
    expect(res.status).toBe(201);
    const up = await res.json();
    expect(up.labels.sort()).toEqual(["gateway", "ops"]);
    expect(up.origin).toBe("authored");
    expect((await call("GET", `/kb/documents/${up.id}/original`)).status).toBe(404);

    const html = new FormData();
    html.set(
      "file",
      new File(
        ["<html><body><h1>Escalation</h1><p>Page the on-call lead.</p></body></html>"],
        "escalation.html",
      ),
    );
    const file = await (await call("POST", `/kb/bases/${kbId}/upload`, html)).json();
    expect(file.origin).toBe("upload");
    await idle();
    const parsed = await (await call("GET", `/kb/documents/${file.id}`)).json();
    expect(parsed.parse_state).toBe("ok");
    expect(parsed.content).toContain("Page the on-call lead");
    const orig = await call("GET", `/kb/documents/${file.id}/original`);
    expect(orig.status).toBe(200);
    expect(orig.headers.get("content-security-policy")).toBe("sandbox");
    expect(await orig.text()).toContain("<h1>Escalation</h1>");

    const missing = await call("POST", `/kb/bases/${kbId}/upload`, new FormData());
    expect(missing.status).toBe(400);

    const escaping = new FormData();
    escaping.set("file", new File(["<p>x</p>"], "page.html"));
    escaping.set("path", "../../outside.html");
    expect((await call("POST", `/kb/bases/${kbId}/upload`, escaping)).status).toBe(400);
  });

  test("upload: the size limit holds for chunked bodies without a Content-Length", async () => {
    expect((await call("PATCH", "/kb/settings", { max_upload_bytes: 4096 })).status).toBe(200);
    try {
      const form = new FormData();
      form.set("file", new File(["x".repeat(256 * 1024)], "big.txt"));
      const encoded = new Response(form);
      const res = await app.request(`/api/kb/bases/${kbId}/upload`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-secret",
          "Content-Type": encoded.headers.get("content-type") ?? "",
        },
        body: encoded.body,
        duplex: "half",
      } as RequestInit);
      expect(res.status).toBe(413);
      expect(((await res.json()) as { code: string }).code).toBe("TOO_LARGE");
    } finally {
      await call("PATCH", "/kb/settings", { max_upload_bytes: 100 * 1024 * 1024 });
    }
  });

  test("search and evidence return citations that resolve; reads are counted by source", async () => {
    await idle();
    const search = await (
      await call(
        "POST",
        "/kb/search",
        { query: "restore backup key", scope: "all" },
        { "X-Orc-Source": "cli" },
      )
    ).json();
    const hit = search.hits.find((h: { document_id: string }) => h.document_id === docId);
    expect(hit).toBeDefined();
    const citation: string = hit.passages[0].citation;
    expect(citation).toMatch(new RegExp(`^kb:${docId}@2#\\d+$`));

    const cited = await call("GET", `/kb/citations/${encodeURIComponent(citation)}`, undefined, {
      "X-Orc-Source": "cli",
    });
    expect(cited.status).toBe(200);
    expect((await call("GET", "/kb/citations/garbage")).status).toBe(400);

    const pack = await (
      await call("POST", "/kb/evidence", {
        query: "how do I roll back the signing key",
        scope: "all",
      })
    ).json();
    expect(pack.items.some((i: { document_id: string }) => i.document_id === docId)).toBe(true);

    const usage = await (await call("GET", `/kb/documents/${docId}/usage`)).json();
    expect(usage.totals.ui.fetch).toBeGreaterThanOrEqual(1);
    expect(usage.totals.cli.fetch + usage.totals.cli.cited).toBeGreaterThanOrEqual(1);
    expect(usage.totals.cli.search_hit).toBeGreaterThanOrEqual(1);
    expect(usage.totals.api.cited).toBeGreaterThanOrEqual(1);
    expect(usage.totals.mcp.fetch).toBe(0);
    const kbUsage = await (await call("GET", `/kb/bases/${kbId}/usage`)).json();
    expect(kbUsage.reads).toBeGreaterThanOrEqual(usage.reads);
  });

  test("editable_by: MCP writes where allowed, and cannot change the list itself", async () => {
    const created = await call(
      "POST",
      `/kb/bases/${learnId}/documents`,
      { title: "Gateway restarts", content: "# Gateway restarts\n\nRestart it." },
      agent,
    );
    expect(created.status).toBe(201);
    const doc = await created.json();
    const revs = await (await call("GET", `/kb/documents/${doc.id}/revisions`)).json();
    expect(revs.revisions[0].source).toBe("mcp");

    const grant = { editable_by: ["mcp", "ui"] };
    expect((await call("PATCH", `/kb/bases/${kbId}`, grant, agent)).status).toBe(403);
    const kb = await (
      await call("PATCH", `/kb/bases/${kbId}`, { editable_by: ["ui", "api"] })
    ).json();
    expect(kb.editable_by).toEqual(["api", "ui"]);
    expect((await call("PATCH", `/kb/bases/${kbId}`, { editable_by: ["root"] })).status).toBe(400);
    expect(
      (
        await call(
          "PATCH",
          `/kb/documents/${docId}`,
          { expected_revision: 2, title: "x" },
          { "X-Orc-Source": "cli" },
        )
      ).status,
    ).toBe(403);
    await call("PATCH", `/kb/bases/${kbId}`, { editable_by: ["ui", "cli", "api"] });
  });

  test("status, parsers and settings; MCP cannot change settings; the key is stored encrypted", async () => {
    const status = await call("GET", "/kb/status");
    expect(status.status).toBe(200);
    const parsers = await (await call("GET", "/kb/parsers")).json();
    expect(parsers.parsers.some((p: { id: string; installed: boolean }) => p.installed)).toBe(true);
    expect(parsers.docling.state).toBeDefined();

    const settings = await (await call("GET", "/kb/settings")).json();
    expect(settings.env_overrides).toContain("ORC_KNOWLEDGE_ROOT");
    expect(JSON.stringify(settings)).not.toContain('api_key":"');

    expect((await call("PATCH", "/kb/settings", { parser_timeout_secs: 90 }, agent)).status).toBe(
      403,
    );
    expect((await call("PATCH", "/kb/settings", { parser: "nonexistent" })).status).toBe(400);

    // Guard: never touch the developer's real config.
    expect(globalConfigPath().startsWith(home)).toBe(true);
    const patched = await call("PATCH", "/kb/settings", { parser_timeout_secs: 90 });
    expect(patched.status).toBe(200);
    expect((await patched.json()).parser_timeout_secs).toBe(90);
    expect(JSON.parse(readFileSync(globalConfigPath(), "utf8")).knowledge.parser_timeout_secs).toBe(
      90,
    );

    const withCreds = { embedding: { base_url: "https://user:pw@api.example.com/v1" } };
    expect((await call("PATCH", "/kb/settings", withCreds)).status).toBe(400);
    const ftp = { embedding: { base_url: "ftp://example.com" } };
    expect((await call("PATCH", "/kb/settings", ftp)).status).toBe(400);
    const keyed = await call("PATCH", "/kb/settings", {
      embedding: { base_url: "https://api.example.com/v1", api_key: "sk-route-test" },
    });
    expect(keyed.status).toBe(200);
    const body = JSON.stringify(await keyed.json());
    expect(body).not.toContain("sk-route-test");
    expect(body).toContain('"api_key_set":true');
    const onDisk = readFileSync(globalConfigPath(), "utf8");
    expect(onDisk).not.toContain("sk-route-test");
    expect(JSON.parse(onDisk).knowledge.embedding.api_key).toStartWith("enc:v1:");
    expect(loadConfig().knowledge.embedding.api_key).toBe("sk-route-test");
    const cleared = await call("PATCH", "/kb/settings", {
      embedding: { base_url: null, api_key: null },
    });
    expect((await cleared.json()).embedding.api_key_set).toBe(false);
  });

  test("delete document and KBs; then the project can be deleted", async () => {
    expect((await call("DELETE", `/kb/documents/${docId}`)).status).toBe(204);
    expect((await call("GET", `/kb/documents/${docId}`)).status).toBe(404);
    expect((await call("DELETE", `/kb/bases/${kbId}`, undefined, agent)).status).toBe(403);
    expect((await call("DELETE", `/kb/bases/${kbId}`)).status).toBe(204);
    expect((await call("DELETE", `/kb/bases/${learnId}`)).status).toBe(204);
    expect(existsSync(join(home, "knowledge", "bases", kbId))).toBe(false);
    expect((await req(app, "DELETE", `/projects/${projectId}`)).status).toBe(204);
  });
});
