import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "@orc/core/config";
import { closeDb, createTestDb } from "@orc/db/client";
import { closeKnowledgeService, getKnowledgeService } from "@orc/knowledge";
import { executeTool } from "../tools.js";

const human = { source: "ui" as const, actor: {} };
const saved = { ...process.env };
let root: string;
let kbId: string;
let docId: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "orc-mcp-kb-"));
  process.env.ORC_DB_PATH = ":memory:";
  process.env.ORC_ACTIVE_PROJECT = "";
  process.env.ORC_KNOWLEDGE_ROOT = root;
  process.env.ORC_SESSION_ID = "sess-mcp-1";
  resetConfig();
  createTestDb();
  const svc = await getKnowledgeService();
  const kb = svc.createKb(human, {
    name: "Runbooks",
    project_id: null,
  });
  kbId = kb.id;
  docId = svc.createDocument(human, kb.id, {
    title: "Rotating the signing key",
    content:
      "# Rotating the signing key\n\n## Steps\n\nGenerate a new keypair with the vault CLI, then restart the gateway.\n\n## Rollback\n\nRestore the previous key from backup.",
  }).id;
  await svc.jobs.idle();
});

afterAll(async () => {
  await closeKnowledgeService();
  closeDb();
  for (const k of ["ORC_DB_PATH", "ORC_ACTIVE_PROJECT", "ORC_KNOWLEDGE_ROOT", "ORC_SESSION_ID"])
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  resetConfig();
  rmSync(root, { recursive: true, force: true });
});

describe("MCP kb tools", () => {
  test("kb_list shows global KBs and whether MCP may edit them", async () => {
    const out = await executeTool("kb_list", {});
    expect(out).toContain(kbId);
    expect(out).toContain("Runbooks [global] 1 docs editable");
  });

  test("kb_search returns citation handles", async () => {
    const out = await executeTool("kb_search", { query: "signing key vault", limit: 5 });
    expect(out).toContain(`id:${docId}`);
    expect(out).toMatch(new RegExp(`kb:${docId}@1#\\d+`));
  });

  test("kb_evidence packs cited passages", async () => {
    const out = await executeTool("kb_evidence", { query: "how to rollback the signing key" });
    expect(out).toContain(`[kb:${docId}@1#`);
    expect(out).toContain("Restore the previous key");
  });

  test("kb_read by heading and by citation; reads are attributed to mcp", async () => {
    const section = await executeTool("kb_read", { id: docId, heading: "Rollback" });
    expect(section).toContain("Restore the previous key");
    expect(section).not.toContain("Generate a new keypair");
    const handle = (await executeTool("kb_search", { query: "rollback backup" })).match(
      /kb:\S+@\d+#\d+/,
    )?.[0];
    expect(handle).toBeDefined();
    const passage = await executeTool("kb_read", { citation: handle });
    expect(passage).toContain(handle as string);

    const usage = (await getKnowledgeService()).documentUsage(docId);
    expect(usage.totals.mcp.fetch + usage.totals.mcp.cited).toBeGreaterThanOrEqual(2);
    expect(usage.distinct_sessions).toBe(1);
  });

  test("kb_write creates and replaces documents only where editable_by allows mcp", async () => {
    const docs = await executeTool("kb_documents", { kb_id: kbId });
    expect(docs).toContain(docId);
    const out = await executeTool("kb_write", {
      kb_id: kbId,
      title: "Gateway restarts",
      content: "# Gateway restarts\n\nRestart with `orc daemon restart`.",
      note: "Learned while rotating keys",
      derived_from: [docId],
    });
    expect(out).toMatch(/^Created \S+ "Gateway restarts"/);
    const id = out.split(" ")[1] ?? "";
    await expect(
      executeTool("kb_write", { document_id: id, content: "x", note: "n" }),
    ).rejects.toThrow(/expected_revision/);
    expect(
      await executeTool("kb_write", {
        document_id: id,
        expected_revision: 1,
        content: "# Gateway restarts\n\nUse `orc daemon restart`.",
        note: "shorter",
      }),
    ).toContain("revision 2");
    const svc = await getKnowledgeService();
    expect(svc.revisions(id)[0]).toMatchObject({ source: "mcp", session_id: "sess-mcp-1" });

    svc.updateKb(human, kbId, { editable_by: ["ui"] });
    expect(await executeTool("kb_list", {})).toContain("read-only");
    await expect(
      executeTool("kb_write", { kb_id: kbId, title: "T", content: "c", note: "n" }),
    ).rejects.toThrow(/cannot be edited from mcp/);
    svc.updateDocument(human, docId, { expected_revision: 1, content: "# Rotating\n\nNew steps." });
    expect(await executeTool("kb_maintenance", { kb_id: kbId })).toContain("Stale");
  });

  test("tool errors surface instead of crashing", async () => {
    await expect(executeTool("kb_read", { id: "missing" })).rejects.toThrow();
    expect(await executeTool("kb_read", { citation: "nope" })).toContain("Citation must look like");
  });
});
