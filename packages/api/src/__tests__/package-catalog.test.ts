import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reloadCache } from "@orc/core/skill-service";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
const originalDirectory = process.env.ORC_PACKAGES_DIR;
beforeAll(() => {
  process.env.ORC_PACKAGES_DIR = join(mkdtempSync(join(tmpdir(), "orc-catalog-api-")), "packages");
  app = setupTestApp();
});
afterAll(() => {
  if (originalDirectory === undefined) delete process.env.ORC_PACKAGES_DIR;
  else process.env.ORC_PACKAGES_DIR = originalDirectory;
  reloadCache();
  teardownTestApp();
});

test("catalog edits use revisions and preserve binary assets through HTTP", async () => {
  const name = "my-api-configuration";
  const created = await req(app, "POST", "/agent-packages", {
    name,
    content: `name: ${name}\nversion: 1.0.0\n`,
    files: [{ path: "asset.bin", content: "AP8=", encoding: "base64" }],
  });
  expect(created.status).toBe(201);
  const initial = await (await req(app, "GET", `/agent-packages/${name}`)).json();
  expect(initial.revision).toMatch(/^[a-f0-9]{64}$/);
  const input = {
    expectedRevision: initial.revision,
    content: `name: ${name}\nversion: 1.1.0\n`,
    files: [{ path: "asset.bin", content: "AP8=", encoding: "base64" }],
  };
  expect((await req(app, "PUT", `/agent-packages/${name}`, input)).status).toBe(200);
  expect((await req(app, "PUT", `/agent-packages/${name}`, input)).status).toBe(409);
  expect(
    (await (await req(app, "GET", `/agent-packages/${name}?ref=asset.bin`)).json()).content,
  ).toBe("AP8=");
});

test("new operation endpoints require authentication and reject invalid sources and expired snapshots", async () => {
  for (const path of [
    "/agent-packages/discover",
    "/agent-packages/acquire",
    "/agent-packages/import-acquired",
    "/agent-packages/import-git",
    "/agent-packages/test/export",
    "/agent-setups/command",
  ])
    expect(
      (
        await app.request(`/api${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
  expect((await req(app, "POST", "/agent-packages/acquire", { source: "--force" })).status).toBe(
    400,
  );
  expect(
    (
      await req(app, "POST", "/agent-packages/import-acquired", {
        token: crypto.randomUUID(),
        path: "apm_modules/org/repo",
      })
    ).status,
  ).toBe(400);
});

test("authored plugin MCP must match its schema; imported invalid components stay inspectable", async () => {
  const name = "mcp-api-configuration";
  const input = {
    name,
    format: "agent-plugin",
    content: JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name,
    }),
    files: [{ path: "mcp.json", content: '{"mcpServers":{}}' }],
  };
  expect((await req(app, "POST", "/agent-packages", input)).status).toBe(400);
  expect((await req(app, "POST", "/agent-packages", { ...input, imported: true })).status).toBe(
    201,
  );
  const inspected = await (await req(app, "GET", `/agent-packages/${name}`)).json();
  expect(inspected.warnings.join(" ")).toContain("MCP configuration");
});
