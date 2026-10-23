import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcConfigSchema } from "@orc/core/config";
import { ArchiveSearchSchema, type ArchiveUpload } from "@orc/core/session-archive";
import { getSqlite } from "@orc/db/client";
import type { EmbeddingProvider } from "@orc/knowledge/embeddings";
import { closeSessionArchive, getSessionArchive, SessionArchive } from "../sessions/archive.js";
import { indexDiscoveredSessions } from "../sessions/archive-local.js";
import { LIVE_CHAT_ID } from "../sessions/common.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof setupTestApp>;
let root: string;
let svc: SessionArchive;
let config = OrcConfigSchema.parse({});
const native = randomUUID();
const oldRoot = process.env.ORC_KNOWLEDGE_ROOT;
const meta = JSON.stringify({
  type: "session_meta",
  payload: { id: native, cwd: "/local/project", source: "cli" },
});
const message = (text: string) =>
  JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });
const upload = (lines = [message("The plane takes off at sunrise")]): ArchiveUpload => ({
  project: "Project A",
  source_id: "fixture-pc",
  agent: "codex",
  session_id: native,
  title: "A conversation",
  metadata: { cwd: "/local/project", subdirectory: "" },
  bundle: {
    version: 1,
    files: [{ path: "session.jsonl", content: `${[meta, ...lines].join("\n")}\n` }],
  },
});
const search = (q: string, rest = {}) => ArchiveSearchSchema.parse({ q, ...rest });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "orc-archive-test-"));
  process.env.ORC_KNOWLEDGE_ROOT = root;
  app = setupTestApp();
  getSqlite().run(
    "INSERT INTO projects (id, name) VALUES ('pa', 'Project A'), ('pb', 'Project B')",
  );
  config = OrcConfigSchema.parse({});
  svc = await SessionArchive.open({
    db: getSqlite(),
    root: join(root, "direct"),
    config: () => config,
  });
});

afterEach(async () => {
  await svc.close();
  await closeSessionArchive();
  teardownTestApp();
  if (oldRoot === undefined) delete process.env.ORC_KNOWLEDGE_ROOT;
  else process.env.ORC_KNOWLEDGE_ROOT = oldRoot;
});

describe("session archive storage and identities", () => {
  test("startup repairs stale index revisions even when chunks are present", async () => {
    const first = await svc.ingest(upload());
    await svc.idle();
    svc.index.db.run("UPDATE chunks SET revision = 0 WHERE document_id = ?", [first.session.id]);
    await svc.close();
    svc = await SessionArchive.open({
      db: getSqlite(),
      root: join(root, "direct"),
      config: () => config,
    });
    await svc.idle();
    expect(svc.index.documentChunks(first.session.id).every((c) => c.revision === 1)).toBe(true);
    expect((await svc.search(search("sunrise"))).sessions[0]?.id).toBe(first.session.id);
  });
  test("legacy session citations survive reindex and appends while new revisions use safe splitting", async () => {
    const text = "A sentence with whitespace and historical citation boundaries. ".repeat(80);
    const first = await svc.ingest(upload([message(text)]));
    await svc.idle();
    getSqlite().run("UPDATE session_archive_revisions SET chunk_version = 1 WHERE session_id = ?", [
      first.session.id,
    ]);
    await svc.ingest({ ...upload([message(text)]), reindex: true });
    await svc.idle();
    expect((await svc.citation(first.session.id, 1, 0)).text).toBe(text.slice(0, 1600));
    expect(svc.index.documentChunks(first.session.id)[0]?.text).toBe(text.slice(0, 1600));
    await svc.ingest(upload([message(text), message(`A${"😀".repeat(1600)}`)]));
    await svc.idle();
    expect((await svc.citation(first.session.id, 1, 0)).text).toBe(text.slice(0, 1600));
    for (const chunk of svc.index.documentChunks(first.session.id)) {
      expect(new TextDecoder().decode(new TextEncoder().encode(chunk.text))).toBe(chunk.text);
      expect((await svc.citation(first.session.id, 2, chunk.ordinal)).text).toBe(chunk.text);
    }
  });
  test("simultaneous indexing scans each requested project and coalesces only identical scopes", async () => {
    for (const project of ["pa", "pb"]) {
      const id = randomUUID();
      const path = join(root, `${project}.jsonl`);
      writeFileSync(path, `${meta.replaceAll(native, id)}\n${message("A local transcript")}\n`);
      getSqlite().run(
        "INSERT INTO gateway_sessions (id, chat_id, backend, mode, runtime_session_id, transcript_path, project_id) VALUES (?, ?, 'codex', 'direct', ?, ?, ?)",
        [id, LIVE_CHAT_ID, id, path, project],
      );
    }
    const a = indexDiscoveredSessions("pa");
    expect(indexDiscoveredSessions("pa")).toBe(a);
    const b = indexDiscoveredSessions("pb");
    const results = await Promise.all([a, b]);
    expect(results.map((r) => r.indexed)).toEqual([1, 1]);
    expect(
      getSqlite().query("SELECT project_id FROM session_archives ORDER BY project_id").all(),
    ).toEqual([{ project_id: "pa" }, { project_id: "pb" }]);
  });
  test("TLS proxy grants retain the request host and HTTPS scheme", async () => {
    const response = await app.request("http://orc.example.com/api/sessions/archive/sync", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-secret",
        "Content-Type": "application/json",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "attacker.example",
      },
      body: JSON.stringify({ projects: ["Project A"] }),
    });
    expect(response.status).toBe(200);
    const grant = (await response.json()) as { sync_url: string };
    expect(new URL(grant.sync_url).origin).toBe("https://orc.example.com");
    expect(new URL(grant.sync_url).pathname).toMatch(/^\/api\/session-sync\/[A-Za-z0-9_-]{43}$/);
  });

  test("requires authentication and a valid existing project", async () => {
    expect((await app.request("/api/sessions/archive", { headers: {} })).status).toBe(401);
    const missing = { ...upload(), project: undefined };
    expect((await req(app, "POST", "/sessions/archive/upload", missing)).status).toBe(400);
    expect(
      (await req(app, "POST", "/sessions/archive/upload", { ...upload(), project: "Missing" }))
        .status,
    ).toBe(404);
    expect((await req(app, "POST", "/sessions/archive/upload", upload())).status).toBe(200);
  });

  test("bounds actual streamed bytes even when Content-Length lies", async () => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 65) controller.enqueue(new Uint8Array(1024 * 1024));
        else controller.close();
      },
    });
    const response = await app.fetch(
      new Request("http://localhost/api/sessions/archive/upload", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-secret",
          "content-type": "application/json",
          "content-length": "1",
        },
        body,
      }),
    );
    expect(response.status).toBe(413);
    expect(
      (getSqlite().query("SELECT count(*) n FROM session_archives").get() as { n: number }).n,
    ).toBe(0);
  });

  test("connected-agent grants permit scoped sync without the master secret and cannot read or launch", async () => {
    expect(
      (
        await app.request("/api/sessions/archive/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projects: ["Project A"] }),
        })
      ).status,
    ).toBe(401);
    const minted = await req(app, "POST", "/sessions/archive/sync", { projects: ["Project A"] });
    const grant = await minted.json<{ sync_url: string }>();
    const base = new URL(grant.sync_url).pathname;
    const token = base.split("/").at(-1) as string;
    const call = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const listing = await call("GET", `${base}/projects`);
    expect(
      ((await listing.json()) as { projects: { id: string }[] }).projects.map((p) => p.id),
    ).toEqual(["pa"]);
    expect((await call("POST", `${base}/upload`, upload())).status).toBe(200);
    expect(
      (await call("POST", `${base}/upload`, { ...upload(), project: "Project B" })).status,
    ).toBe(401);
    const { bundle: _bundle, title: _title, metadata: _metadata, ...identity } = upload();
    expect((await call("POST", `${base}/manifest`, { sessions: [identity] })).status).toBe(200);
    expect((await call("GET", `${base}/transcript`)).status).toBe(401);
    expect((await call("POST", `${base}/terminals`, {})).status).toBe(401);
    expect(
      (
        await app.request("/api/sessions/archive", {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(401);
    expect((await call("GET", `${base}/upload`)).status).toBe(401);
    getSqlite().run("UPDATE session_sync_grants SET expires_at = 0");
    expect((await call("GET", `${base}/projects`)).status).toBe(401);
  });

  test("replays and concurrent identical snapshots create exactly one session/revision", async () => {
    const results = await Promise.all([
      svc.ingest(upload()),
      svc.ingest(upload()),
      svc.ingest(upload()),
    ]);
    expect(results.map((r) => r.outcome)).toEqual(["created", "unchanged", "unchanged"]);
    expect(new Set(results.map((r) => r.session.id)).size).toBe(1);
    expect(svc.history(results[0]?.session.id as string)).toHaveLength(1);
  });

  test("append advances the same session, stale uploads never truncate, divergent history is retained", async () => {
    const first = await svc.ingest(upload());
    const more = upload([message("The plane takes off at sunrise"), message("Check the runway")]);
    const next = await svc.ingest(more);
    expect(next.outcome).toBe("updated");
    expect(next.session.id).toBe(first.session.id);
    expect(next.session.revision).toBe(2);
    expect((await svc.ingest(upload())).outcome).toBe("stale");
    const divergent = await svc.ingest(upload([message("A different first turn")]));
    expect(divergent.outcome).toBe("conflict");
    expect(svc.get(first.session.id).revision).toBe(2);
    expect(svc.history(first.session.id)).toHaveLength(3);
    expect((await svc.ingest(upload([message("A different first turn")]))).outcome).toBe(
      "conflict",
    );
    expect(svc.history(first.session.id)).toHaveLength(3);
    const staleWriter = await svc.ingest({
      ...upload([
        message("The plane takes off at sunrise"),
        message("Check the runway"),
        message("Ready"),
      ]),
      expected_revision: 1,
    });
    expect(staleWriter.outcome).toBe("conflict");
    expect(svc.get(first.session.id).revision).toBe(2);
  });

  test("same native UUID on another PC stays separate and project reassignment is rejected", async () => {
    const one = await svc.ingest(upload());
    const two = await svc.ingest({ ...upload(), source_id: "other-pc" });
    expect(one.session.id).not.toBe(two.session.id);
    expect(svc.ingest({ ...upload(), project: "Project B" })).rejects.toThrow("another project");
  });

  test("invalid JSONL, mixed IDs and paths do not replace an existing revision", async () => {
    const first = await svc.ingest(upload());
    const bad = upload();
    const badFile = bad.bundle.files[0];
    if (!badFile) throw new Error("Missing fixture");
    badFile.content += "{broken";
    expect(svc.ingest(bad)).rejects.toThrow("Invalid session JSONL");
    const path = upload();
    const pathFile = path.bundle.files[0];
    if (!pathFile) throw new Error("Missing fixture");
    pathFile.path = "../../credentials.json";
    expect(svc.ingest(path)).rejects.toThrow("session file path");
    const mixed = upload();
    const mixedFile = mixed.bundle.files[0];
    if (!mixedFile) throw new Error("Missing fixture");
    mixedFile.content = mixedFile.content.replace(native, randomUUID());
    expect(svc.ingest(mixed)).rejects.toThrow("identity");
    expect(svc.get(first.session.id).revision).toBe(1);
  });
});

describe("session retrieval", () => {
  test("large ranked candidate sets load without exceeding SQLite parameter limits", async () => {
    const created = await svc.ingest(upload());
    await svc.idle();
    const chunk = svc.index.documentChunks(created.session.id)[0];
    if (!chunk) throw new Error("Expected an indexed passage");
    const candidates = [...Array.from({ length: 300303 }, (_, n) => -n - 1), chunk.id, chunk.id];
    expect(svc.index.getChunks(candidates).map((c) => c.id)).toEqual([chunk.id]);
  });
  test.each(["lexical", "semantic", "semantic-fallback"] as const)(
    "%s search pages distinct sessions when one history has many matching turns",
    async (variant) => {
      const mode = variant === "semantic-fallback" ? "semantic" : variant;
      await svc.close();
      config.knowledge.session_embeddings = true;
      const provider: EmbeddingProvider = {
        provider: "ollama",
        model: "fixture",
        profile: "fixture-8",
        batchSize: 256,
        async embed(texts) {
          return texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]);
        },
      };
      svc = await SessionArchive.open({
        db: getSqlite(),
        root: join(root, "distinct"),
        config: () => config,
        embedder: () => provider,
      });
      const ids: string[] = [];
      for (const turns of [120, 1, 1]) {
        const id = randomUUID();
        const entry = upload();
        entry.session_id = id;
        entry.title = "Conversation";
        const content = [
          meta.replaceAll(native, id),
          ...Array.from({ length: turns }, (_, n) =>
            JSON.stringify({
              type: "response_item",
              payload: {
                type: "message",
                role: n % 2 ? "assistant" : "user",
                content: [
                  {
                    type: n % 2 ? "output_text" : "input_text",
                    text:
                      turns === 120
                        ? "needle"
                        : "needle with many other unrelated words and tokens",
                  },
                ],
              },
            }),
          ),
        ].join("\n");
        entry.bundle.files = [{ path: "session.jsonl", content }];
        ids.push((await svc.ingest(entry)).session.id);
      }
      await svc.idle();
      if (variant === "semantic-fallback") svc.index.backend = "exact-scan";
      const all = await svc.search(search("needle", { mode, project_id: "pa", limit: 20 }));
      expect(all.sessions.map((s) => s.id).sort()).toEqual([...ids].sort());
      expect(all.sessions.every((s) => s.passages.length <= 3)).toBe(true);
      const expanded = await svc.search(search("needle tokens", { mode: "lexical" }));
      expect(expanded.sessions.map((s) => s.id).sort()).toEqual([...ids].sort());
      expect(expanded.sessions.every((s) => s.passages.length <= 3)).toBe(true);
      const first = await svc.search(search("needle", { mode, limit: 1 }));
      const second = await svc.search(search("needle", { mode, limit: 1, offset: 1 }));
      const third = await svc.search(search("needle", { mode, limit: 1, offset: 2 }));
      expect(new Set([first, second, third].map((p) => p.sessions[0]?.id)).size).toBe(3);
      expect([first, second, third].map((p) => p.has_more)).toEqual([true, true, false]);
    },
  );
  test("browsing remains paged beyond ten thousand archived sessions", async () => {
    const insert = getSqlite().query(
      "INSERT INTO session_archives (id,project_id,source_id,agent,native_id,title,metadata,revision,content_hash,index_revision,created_at,updated_at) VALUES (?,'pa','scale','codex',?,'Scale fixture','{\"subdirectory\":\"\"}',1,'fixture',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
    );
    getSqlite().transaction(() => {
      for (let i = 0; i < 10001; i++)
        insert.run(`scale-${String(i).padStart(5, "0")}`, randomUUID());
    })();
    const last = await svc.search(search("", { offset: 10000, limit: 20, project_id: "pa" }));
    expect(last.sessions).toHaveLength(1);
    expect(last.sessions[0]?.id).toBe("scale-10000");
    expect(last.has_more).toBe(false);
  });

  test("a stalled embedding provider does not block new lexical indexing", async () => {
    await svc.close();
    let release = () => {};
    let entered = () => {};
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    config.knowledge.session_embeddings = true;
    const provider: EmbeddingProvider = {
      provider: "ollama",
      model: "fixture",
      profile: "stalled-8",
      batchSize: 8,
      async embed(texts, kind) {
        if (kind === "document") {
          entered();
          await stalled;
        }
        return texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]);
      },
    };
    svc = await SessionArchive.open({
      db: getSqlite(),
      root: join(root, "stall"),
      config: () => config,
      embedder: () => provider,
    });
    try {
      await svc.ingest(upload());
      await Promise.race([
        started,
        Bun.sleep(1000).then(() => {
          throw new Error("Embedding did not start");
        }),
      ]);
      const second = upload([message("lexical rescue needle")]);
      const secondId = randomUUID();
      second.session_id = secondId;
      second.bundle.files = [
        {
          path: "session.jsonl",
          content: second.bundle.files[0]?.content.replace(native, secondId) ?? "",
        },
      ];
      await svc.ingest(second);
      let found = false;
      for (let i = 0; i < 30; i++) {
        if ((await svc.search(search("rescue", { mode: "lexical" }))).sessions.length) {
          found = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(found).toBe(true);
    } finally {
      release();
      await svc.idle();
    }
  });
  test("reopening with a lost derived index rebuilds from retained native snapshots", async () => {
    const first = await svc.ingest(upload());
    await svc.idle();
    await svc.close();
    renameSync(join(root, "direct", "index.db"), join(root, "direct", "old-index.db"));
    svc = await SessionArchive.open({
      db: getSqlite(),
      root: join(root, "direct"),
      config: () => config,
    });
    await svc.idle();
    expect((await svc.search(search("sunrise"))).sessions[0]?.id).toBe(first.session.id);
    expect(svc.history(first.session.id)).toHaveLength(1);
  });

  test("Claude sidecar evidence is searchable and citations resolve to the retained sidecar", async () => {
    const sessionId = randomUUID();
    const entry = {
      ...upload(),
      agent: "claude" as const,
      session_id: sessionId,
      bundle: {
        version: 1 as const,
        files: [
          {
            path: "session.jsonl",
            content: JSON.stringify({
              type: "user",
              sessionId,
              message: { role: "user", content: "Main conversation" },
            }),
          },
          {
            path: "subagents/agent-fixture.jsonl",
            content: JSON.stringify({
              type: "assistant",
              sessionId,
              message: { role: "assistant", content: "sidecar nebula discovery" },
            }),
          },
        ],
      },
    };
    const result = await svc.ingest(entry);
    await svc.idle();
    const found = await svc.search(search("nebula"));
    const passage = found.sessions[0]?.passages[0];
    expect(passage?.file).toBe("subagents/agent-fixture.jsonl");
    expect((await svc.citation(result.session.id, 1, passage?.ordinal ?? -1)).text).toContain(
      "nebula",
    );
  });
  test("indexes transcript-only matches, scopes before ranking and pins citations across appends", async () => {
    const first = await svc.ingest(upload());
    await svc.idle();
    const result = await svc.search(search("sunrise", { project_id: "pa" }));
    expect(result.mode).toBe("lexical");
    expect(result.sessions[0]?.id).toBe(first.session.id);
    expect((await svc.search(search("sunrise", { project_id: "pb" }))).sessions).toHaveLength(0);
    const citation = result.sessions[0]?.passages[0];
    expect(citation?.citation).toBe(`session:${first.session.id}@1#0`);
    await svc.ingest(upload([message("The plane takes off at sunrise"), message("New message")]));
    expect((await svc.citation(first.session.id, 1, 0)).text).toContain("sunrise");
    expect(svc.bundle(first.session.id, 1).bundle.files[0]?.content).not.toContain("New message");
  });

  test("API reads pages and exports the pinned native bundle", async () => {
    const created = await req(
      app,
      "POST",
      "/sessions/archive/upload",
      upload([message("One"), message("Two")]),
    );
    const { session } = await created.json();
    const list = await req(app, "GET", "/sessions/archive?project_id=pa");
    expect(list.status).toBe(200);
    expect((await list.json()).sessions[0].id).toBe(session.id);
    const page = await req(
      app,
      "GET",
      `/sessions/archive/${session.id}/transcript?offset=1&limit=1&revision=1`,
    );
    expect(page.status).toBe(200);
    expect((await page.json()).turns[0].blocks[0].text).toBe("Two");
    const exported = await req(app, "GET", `/sessions/archive/${session.id}/export?revision=1`);
    expect(await exported.json<unknown>()).toEqual(upload([message("One"), message("Two")]).bundle);
    expect(
      (await req(app, "GET", `/sessions/archive/${session.id}/transcript?limit=501`)).status,
    ).toBe(400);
    expect(
      (await req(app, "GET", `/sessions/archive/${session.id}/transcript?revision=999`)).status,
    ).toBe(404);
    await (await getSessionArchive()).idle();
  });

  test("optional embeddings backfill, reuse unchanged vectors, and fall back during an outage", async () => {
    await svc.close();
    let calls = 0;
    let failed = false;
    const provider: EmbeddingProvider = {
      provider: "ollama",
      model: "fixture",
      profile: "fixture-8",
      batchSize: 8,
      async embed(texts, kind) {
        if (kind === "query" && failed) throw new Error("provider secret must not leak");
        if (kind === "document") calls += texts.length;
        return texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]);
      },
    };
    svc = await SessionArchive.open({
      db: getSqlite(),
      root: join(root, "vectors"),
      config: () => config,
      embedder: () => provider,
    });
    await svc.ingest(upload());
    await svc.idle();
    expect(calls).toBe(0);
    config.knowledge.session_embeddings = true;
    await svc.idle();
    expect(calls).toBe(1);
    expect((await svc.search(search("aircraft"))).sessions[0]?.native_id).toBe(native);
    await svc.ingest(upload([message("The plane takes off at sunrise"), message("New message")]));
    await svc.idle();
    expect(calls).toBe(2);
    failed = true;
    const fallback = await svc.search(search("sunrise"));
    expect(fallback.mode).toBe("lexical");
    expect(fallback.degraded).toContain("keyword");
    expect(fallback.degraded).not.toContain("secret");
    expect(fallback.sessions).toHaveLength(1);
    config.knowledge.session_embeddings = false;
    expect((await svc.search(search("sunrise"))).degraded).toBeUndefined();
  });
});
