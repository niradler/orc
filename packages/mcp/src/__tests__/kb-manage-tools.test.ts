import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resetConfig } from "@orc/core/config";
import { closeDb, createTestDb } from "@orc/db/client";
import { closeKnowledgeService, getKnowledgeService } from "@orc/knowledge";
import { createMcpServer } from "../server.js";
import { executeTool } from "../tools.js";

const ENV = ["ORC_DB_PATH", "ORC_ACTIVE_PROJECT", "ORC_KNOWLEDGE_ROOT", "ORC_SESSION_ID"];
const saved = { ...process.env };
let root: string;
let kb: string;
let doc: string;

/** The id a "Created …" / "Added comment …" reply names. */
const idOf = (out: string) =>
  out.match(/^(?:Created knowledge base|Created|Added comment) ([0-9a-z]+)/)?.[1] ?? "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orc-mcp-kb-manage-"));
  process.env.ORC_DB_PATH = ":memory:";
  process.env.ORC_ACTIVE_PROJECT = "";
  process.env.ORC_KNOWLEDGE_ROOT = root;
  process.env.ORC_SESSION_ID = "sess-mcp-2";
  resetConfig();
  createTestDb();
});

afterEach(async () => {
  (await getKnowledgeService()).jobHooks = null;
  delete process.env.ORC_API_BASE;
});

afterAll(async () => {
  await closeKnowledgeService();
  closeDb();
  for (const k of [...ENV, "ORC_API_BASE"])
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  resetConfig();
  rmSync(root, { recursive: true, force: true });
});

describe("MCP kb management, edits, comments and digests", () => {
  test("kb_list says how to create a KB when there is none", async () => {
    expect(await executeTool("kb_list", {})).toContain("kb_manage action create");
  });

  test("should expose Markdown paths and accept document_id through the MCP protocol", async () => {
    const server = createMcpServer();
    const client = new Client({ name: "kb-contract-test", version: "1" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args });
    try {
      const { tools } = await client.listTools();
      const path = tools.find((tool) => tool.name === "kb_write")?.inputSchema.properties?.path;
      expect(path).toHaveProperty("description", expect.stringContaining(".md"));
      expect(path).toHaveProperty("pattern");
      const base = idOf(
        await executeTool("kb_manage", { action: "create", name: "Contract", global: true }),
      );
      expect(
        await call("kb_write", {
          kb_id: base,
          title: "Invalid path",
          path: "scratch/repro",
          content: "x",
          note: "repro",
        }),
      ).toHaveProperty("isError", true);
      for (const key of ["document_id", "id"]) {
        const id = idOf(
          await executeTool("kb_write", {
            kb_id: base,
            title: key,
            path: `${key}.${key === "id" ? "MARKDOWN" : "md"}`,
            content: "original",
            note: "fixture",
          }),
        );
        const target = { [key]: id };
        expect(await call("kb_document", { action: "history", ...target })).not.toHaveProperty(
          "isError",
          true,
        );
        expect(
          await call("kb_document", {
            action: "edit",
            ...target,
            expected_revision: 1,
            edits: [{ old: "original", new: "edited" }],
            note: "edit",
          }),
        ).not.toHaveProperty("isError", true);
        expect(
          await call("kb_document", {
            action: "update",
            ...target,
            expected_revision: 2,
            title: "Renamed",
          }),
        ).not.toHaveProperty("isError", true);
        expect(
          await call("kb_document", {
            action: "restore",
            ...target,
            expected_revision: 3,
            revision: 1,
          }),
        ).not.toHaveProperty("isError", true);
        expect(
          (await getKnowledgeService()).getDocument({ source: "mcp", actor: {} }, id).content,
        ).toBe("original");
        expect(
          await call("kb_document", {
            action: "update",
            ...target,
            expected_revision: 1,
            title: "Stale",
          }),
        ).toHaveProperty("isError", true);
        expect(
          await call("kb_document", { action: "history", id, document_id: "other" }),
        ).toHaveProperty("isError", true);
        expect(
          await call("kb_document", { action: "history", id, document_id: id }),
        ).not.toHaveProperty("isError", true);
        expect(await call("kb_document", { action: "delete", ...target })).not.toHaveProperty(
          "isError",
          true,
        );
      }
      expect(await call("kb_document", { action: "history" })).toHaveProperty("isError", true);
      expect(await call("kb_document", { action: "history", document_id: "" })).toHaveProperty(
        "isError",
        true,
      );
      const locked = idOf(
        await executeTool("kb_write", {
          kb_id: base,
          title: "Locked",
          content: "original",
          note: "fixture",
        }),
      );
      const service = await getKnowledgeService();
      service.updateKb({ source: "ui", actor: {} }, base, { editable_by: ["ui"] });
      expect(
        await call("kb_document", {
          action: "update",
          document_id: locked,
          expected_revision: 1,
          title: "Forbidden",
        }),
      ).toHaveProperty("isError", true);
      expect(service.getDocument({ source: "mcp", actor: {} }, locked).title).toBe("Locked");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("kb_manage creates, updates and deletes with the exact name", async () => {
    await expect(executeTool("kb_manage", { action: "create", name: "Nope" })).rejects.toThrow(
      /global:true/,
    );
    const out = await executeTool("kb_manage", { action: "create", name: "Lessons", global: true });
    expect(out).toContain('"Lessons" [global]');
    kb = idOf(out);
    expect(
      await executeTool("kb_manage", {
        action: "update",
        kb_id: kb,
        description: "What we learned",
      }),
    ).toContain("Updated");
    const temp = idOf(
      await executeTool("kb_manage", { action: "create", name: "Tmp", global: true }),
    );
    await expect(executeTool("kb_manage", { action: "delete", kb_id: temp })).rejects.toThrow(
      /confirm/,
    );
    expect(
      await executeTool("kb_manage", { action: "delete", kb_id: temp, confirm: "Tmp" }),
    ).toContain("Deleted");
  });

  test("kb_read numbered lines, then kb_document edit, update, history and restore", async () => {
    doc = idOf(
      await executeTool("kb_write", {
        kb_id: kb,
        title: "Releases",
        description: "How we ship",
        content: "# Releases\n\nbump versions\nrun checks\npublish\n",
        note: "start",
      }),
    );
    const lines = await executeTool("kb_read", { id: doc, start_line: 3, end_line: 4 });
    expect(lines).toContain("lines 3-4 of 5");
    expect(lines).toContain("3| bump versions\n4| run checks");

    const edited = await executeTool("kb_document", {
      action: "edit",
      id: doc,
      expected_revision: 1,
      note: "detail",
      edits: [
        { start_line: 4, end_line: 4, new: "run checks\nrun ci:full" },
        { old: "publish", new: "publish with --otp" },
      ],
    });
    expect(edited).toContain("revision 2");
    expect(edited).toContain("1: lines 4-5; 2: lines 6-6");
    await expect(
      executeTool("kb_document", { action: "edit", id: doc, edits: [{ old: "a", new: "b" }] }),
    ).rejects.toThrow(/expected_revision/);

    expect(
      await executeTool("kb_document", {
        action: "update",
        id: doc,
        expected_revision: 2,
        path: "process/releases.md",
      }),
    ).toContain("process/releases.md");
    expect(await executeTool("kb_document", { action: "history", id: doc })).toMatch(
      /rev 3[\s\S]*rev 1/,
    );
    expect(
      await executeTool("kb_document", {
        action: "restore",
        id: doc,
        revision: 1,
        expected_revision: 3,
      }),
    ).toContain("as revision 4");
  });

  test("kb_comment adds, lists open first, resolves with a reply", async () => {
    const c1 = idOf(
      await executeTool("kb_comment", {
        action: "add",
        kb_id: kb,
        document_id: doc,
        body: "Add rollback",
      }),
    );
    const c2 = idOf(
      await executeTool("kb_comment", { action: "add", kb_id: kb, body: "Digest the release doc" }),
    );
    expect(
      await executeTool("kb_comment", {
        action: "resolve",
        comment_id: c1,
        reply: "Added rollback",
      }),
    ).toContain("resolved");
    const list = await executeTool("kb_comment", { action: "list", kb_id: kb });
    expect(list.startsWith("1 open · 1 resolved · 0 dismissed")).toBe(true);
    expect(list.indexOf(c2)).toBeLessThan(list.indexOf(c1));
    expect(list).toContain("-> ");
    expect(list).toContain('on "Releases"');
  });

  test("kb_digest in the daemon uses the service; from stdio it asks the API", async () => {
    expect(await executeTool("kb_digest", { action: "template" })).toContain("open comment");
    expect(await executeTool("kb_digest", { action: "get", kb_id: kb })).toContain("No digest");

    const svc = await getKnowledgeService();
    svc.jobHooks = { sync: () => {}, run: async () => "run-1" };
    const set = await executeTool("kb_digest", {
      action: "set",
      kb_id: kb,
      backend: "codex",
      schedule: { type: "manual" },
    });
    expect(set).toContain("backend: codex  schedule: manual");
    expect(set).toContain("open comments: 1");
    expect(await executeTool("kb_digest", { action: "run", kb_id: kb })).toContain("run-1");
    expect(await executeTool("kb_digest", { action: "runs", kb_id: kb })).toBe("No runs yet.");

    // A stdio MCP process has no job hooks: scheduling and runs go to the daemon's API.
    svc.jobHooks = null;
    const seen: { call: string; source: string | null; session: string | null }[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        seen.push({
          call: `${request.method} ${url.pathname}${url.search}`,
          source: request.headers.get("x-orc-source"),
          session: request.headers.get("x-orc-session-id"),
        });
        if (url.pathname.endsWith("/digest/run"))
          return Response.json({ run_id: "run-api" }, { status: 202 });
        if (request.method === "DELETE")
          return Response.json({ error: "Set confirm", code: "VALIDATION_ERROR" }, { status: 400 });
        return Response.json(svc.getDigest(kb));
      },
    });
    process.env.ORC_API_BASE = `http://127.0.0.1:${server.port}`;
    try {
      expect(await executeTool("kb_digest", { action: "run", kb_id: kb })).toContain("run-api");
      expect(
        await executeTool("kb_digest", { action: "set", kb_id: kb, enabled: false }),
      ).toContain("Digest saved");
      await expect(
        executeTool("kb_digest", { action: "delete", kb_id: kb, confirm: "Les sons" }),
      ).rejects.toThrow("Set confirm");
    } finally {
      server.stop(true);
    }
    expect(seen.map((s) => s.call)).toEqual([
      `POST /api/kb/bases/${kb}/digest/run`,
      `PUT /api/kb/bases/${kb}/digest`,
      `DELETE /api/kb/bases/${kb}/digest?confirm=Les%20sons`,
    ]);
    expect(seen.every((s) => s.source === "mcp" && s.session === "sess-mcp-2")).toBe(true);
  });
});
