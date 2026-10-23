import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "@orc/core/config";
import { closeKnowledgeService, getKnowledgeService } from "@orc/knowledge";
import { closeSessionArchive } from "../sessions/archive.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

const saved = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  ORC_KNOWLEDGE_ROOT: process.env.ORC_KNOWLEDGE_ROOT,
};
let app: ReturnType<typeof setupTestApp>;
let provider: ReturnType<typeof Bun.serve>;
let unavailable = false;
const requests: string[][] = [];

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "orc-vector-http-"));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.ORC_KNOWLEDGE_ROOT = join(root, "knowledge");
  app = setupTestApp();
  provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(r) {
      const body = (await r.json()) as { input: string[] };
      requests.push(body.input);
      if (unavailable)
        return new Response("private-provider-token private-document-input", { status: 503 });
      return Response.json({
        embeddings: body.input.map((t) => [
          Number(t.includes("phoenix")),
          Number(t.includes("lunar")),
          0.1,
        ]),
      });
    },
  });
});

afterAll(async () => {
  await closeSessionArchive();
  await closeKnowledgeService();
  provider.stop(true);
  teardownTestApp();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfig();
});

test("HTTP lifecycle: authenticated settings, parser upload, vectors, scoped evidence, revisions, failure recovery and deletion", async () => {
  expect(
    (
      await app.request("/api/kb/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "phoenix" }),
      })
    ).status,
  ).toBe(401);
  const settings = await req(app, "PATCH", "/kb/settings", {
    embedding: {
      provider: "ollama",
      base_url: `http://127.0.0.1:${provider.port}`,
      model: "fixture",
      api_key: "private-provider-token",
      batch_size: 2,
    },
  });
  expect(settings.status).toBe(200);
  expect(JSON.stringify(await settings.json())).not.toContain("private-provider-token");
  const kb = await (
    await req(app, "POST", "/kb/bases", { name: "Pipeline fixture", project_id: null })
  ).json();
  const form = new FormData();
  form.append(
    "file",
    new File(
      [
        "<html><title>Recovery</title><h1>Operations</h1><p>phoenix repair instructions</p><table><tr><th>Step</th><th>Action</th></tr><tr><td>1</td><td>Check checksum</td></tr></table></html>",
      ],
      "runbook.html",
      { type: "text/html" },
    ),
  );
  const uploaded = await app.request(`/api/kb/bases/${kb.id}/upload`, {
    method: "POST",
    headers: { authorization: "Bearer test-secret" },
    body: form,
  });
  expect(uploaded.status).toBe(201);
  const doc = (await uploaded.json()) as { id: string };
  const service = await getKnowledgeService();
  await service.jobs.idle();
  expect(service.engine.catalog.doc(doc.id)?.index_state).toBe("semantic_ready");
  const result = await (
    await req(app, "POST", "/kb/search", { query: "phoenix", mode: "hybrid", kb_ids: [kb.id] })
  ).json();
  expect(result.hits[0].document_id).toBe(doc.id);
  const passage = result.hits[0].passages[0];
  const cited = await req(app, "GET", `/kb/citations/${encodeURIComponent(passage.citation)}`);
  expect(cited.status).toBe(200);
  expect((await cited.json()).content).toBe(passage.text);
  const evidence = await (
    await req(app, "POST", "/kb/evidence", { query: "phoenix", kb_ids: [kb.id], token_budget: 500 })
  ).json();
  expect(evidence.items.length).toBeGreaterThan(0);
  expect(evidence.token_estimate).toBeLessThanOrEqual(500);
  expect(evidence.items.every((item: { document_id: string }) => item.document_id === doc.id)).toBe(
    true,
  );
  const excluded = await (
    await req(app, "POST", "/kb/search", {
      query: "phoenix",
      mode: "semantic",
      labels: ["excluded"],
      kb_ids: [kb.id],
    })
  ).json();
  expect(excluded.hits).toEqual([]);

  const editable = await (
    await req(app, "POST", `/kb/bases/${kb.id}/documents`, {
      title: "Mutable",
      content: "phoenix old edition",
    })
  ).json();
  await service.jobs.idle();
  const old = service.engine.idx.documentChunks(editable.id)[0];
  if (!old) throw Error("Missing indexed fixture");
  const oldCitation = `kb:${editable.id}@1#${old.ordinal}`;
  expect(
    (
      await req(app, "PATCH", `/kb/documents/${editable.id}`, {
        expected_revision: 1,
        content: "lunar new edition",
      })
    ).status,
  ).toBe(200);
  await service.jobs.idle();
  expect((await req(app, "GET", `/kb/citations/${encodeURIComponent(oldCitation)}`)).status).toBe(
    409,
  );
  expect(
    service.engine.idx
      .documentChunks(editable.id)
      .every((c) => c.revision === 2 && !c.text.includes("old edition")),
  ).toBe(true);

  unavailable = true;
  const fallback = await (
    await req(app, "POST", "/kb/search", { query: "phoenix", mode: "semantic", kb_ids: [kb.id] })
  ).json();
  expect(fallback.mode).toBe("lexical");
  expect(fallback.hits.some((hit: { document_id: string }) => hit.document_id === doc.id)).toBe(
    true,
  );
  expect(JSON.stringify(fallback)).not.toContain("private-provider-token");
  unavailable = false;
  expect(
    (await (await req(app, "POST", "/kb/search", { query: "phoenix", mode: "semantic" })).json())
      .mode,
  ).toBe("semantic");
  const beforeRestart = requests.length;
  await closeKnowledgeService();
  const reopened = await getKnowledgeService();
  await reopened.jobs.idle();
  expect(requests.length).toBe(beforeRestart);
  expect((await req(app, "DELETE", `/kb/documents/${doc.id}`)).status).toBe(204);
  expect(reopened.engine.idx.documentChunks(doc.id)).toEqual([]);
  const afterDelete = await (
    await req(app, "POST", "/kb/search", { query: "phoenix", mode: "hybrid", kb_ids: [kb.id] })
  ).json();
  expect(afterDelete.hits.some((hit: { document_id: string }) => hit.document_id === doc.id)).toBe(
    false,
  );
});
