import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { getUserAgentsDir } from "@orc/core/agent-service";
import { getPackagesDir } from "@orc/core/package-service";
import { reloadCache } from "@orc/core/skill-service";
import { executeTool } from "@orc/mcp/tools";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
const id = `api-shared-agent-${process.pid}`;
const name = `api-shared-package-${process.pid}`;
beforeAll(() => {
  app = setupTestApp();
});
afterAll(() => {
  rmSync(join(getUserAgentsDir(), `${id}.agent.md`), { force: true });
  rmSync(join(getPackagesDir(), name), { recursive: true, force: true });
  reloadCache();
  teardownTestApp();
});

describe("shared agent and package contracts", () => {
  test("should create through HTTP and discover/read the same definition through MCP", async () => {
    const content =
      "---\ndescription: Shared reviewer\ntools:\n  Read: true\nhandoffs: [build]\n---\nReview evidence.";
    const created = await req(app, "POST", "/agents", { id, content });
    expect(created.status).toBe(201);
    expect((await req(app, "GET", `/agents/${id}`)).status).toBe(200);
    const library = JSON.parse(await executeTool("agent_list", {}));
    expect(library.agents.some((agent: { id: string }) => agent.id === id)).toBe(true);
    expect(JSON.parse(await executeTool("agent_read", { id })).raw).toBe(content);
    expect((await req(app, "POST", "/agents", { id, content })).status).toBe(409);
  });
  test("should import through MCP and read package resources and profiles through HTTP", async () => {
    const manifest = `name: ${name}\nversion: '1.0.0'\nx-custom: kept\n`;
    const imported = JSON.parse(
      await executeTool("agent_package_import", {
        name,
        content: manifest,
        files: [
          {
            path: ".apm/agents/review.agent.md",
            content: "---\ndescription: Review\n---\nRead ../../references/policy.md.",
          },
          { path: "references/policy.md", content: "Shared policy" },
        ],
      }),
    );
    expect(imported.files).toHaveLength(2);
    const profile = await req(app, "GET", `/agents/${encodeURIComponent(`${name}/review`)}`);
    expect(profile.status).toBe(200);
    expect((await profile.json()).content).toContain("../../references/policy.md");
    const pkg = await req(app, "GET", `/agent-packages/${name}`);
    expect((await pkg.json()).content).toBe(manifest);
    const file = await req(app, "GET", `/agent-packages/${name}?ref=references%2Fpolicy.md`);
    expect((await file.json()).content).toBe("Shared policy");
  });
  test("should reject invalid definitions and require configured authentication", async () => {
    expect(
      (await req(app, "POST", "/agents", { id: "invalid", content: "---\nname: bad\n---\nBody" }))
        .status,
    ).toBe(400);
    expect(
      (
        await req(app, "POST", "/agent-packages", {
          name: "invalid",
          content: "name: invalid\n",
          files: [],
        })
      ).status,
    ).toBe(400);
    expect((await req(app, "GET", `/agent-packages/${name}?ref=..%2Fsecret`)).status).toBe(400);
    expect((await app.request("/api/agents")).status).toBe(401);
    expect((await app.request("/api/agent-packages")).status).toBe(401);
  });
  test("should update definitions, preserve extensions and reject stale or invalid writes", async () => {
    const original = await (await req(app, "GET", `/agents/${id}`)).json();
    const input = {
      content:
        "---\nname: Updated reviewer\ndescription: Review changes\ntools: { Read: true, Bash: false }\ncustom-field: preserved\n---\nUpdated instructions.",
      expectedRaw: original.raw,
      expectedPath: original.path,
    };
    expect(
      (
        await app.request(`/api/agents/${id}`, {
          method: "PUT",
          body: JSON.stringify(input),
          headers: { "Content-Type": "application/json" },
        })
      ).status,
    ).toBe(401);
    const updated = await req(app, "PUT", `/agents/${id}`, input);
    expect(updated.status).toBe(200);
    expect((await updated.json()).fields["custom-field"]).toBe("preserved");
    expect((await req(app, "PUT", `/agents/${id}`, input)).status).toBe(409);
    const latest = await (await req(app, "GET", `/agents/${id}`)).json();
    expect(
      (
        await req(app, "PUT", `/agents/${id}`, {
          ...input,
          expectedRaw: latest.raw,
          content: "not yaml",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await req(app, "PUT", `/agents/${id}`, {
          ...input,
          expectedRaw: latest.raw,
          expectedPath: "another-file.agent.md",
        })
      ).status,
    ).toBe(409);
    expect((await (await req(app, "GET", `/agents/${id}`)).json()).raw).toBe(latest.raw);
    const packageId = encodeURIComponent(`${name}/review`);
    const packaged = await (await req(app, "GET", `/agents/${packageId}`)).json();
    expect(
      (
        await req(app, "PUT", `/agents/${packageId}`, {
          content: packaged.raw.replace(
            "Read ../../references/policy.md.",
            "Read package policy carefully.",
          ),
          expectedRaw: packaged.raw,
          expectedPath: packaged.path,
        })
      ).status,
    ).toBe(200);
    expect(
      (await (await req(app, "GET", `/agent-packages/${name}?ref=references%2Fpolicy.md`)).json())
        .content,
    ).toBe("Shared policy");
  });
  test("should authenticate deletion and reject traversal without changing profiles", async () => {
    expect((await app.request(`/api/agents/${id}`, { method: "DELETE" })).status).toBe(401);
    for (const invalid of ["../outside", "folder/../outside", "C:\\outside", "folder\\outside"]) {
      expect((await req(app, "DELETE", `/agents/${encodeURIComponent(invalid)}`)).status).toBe(400);
    }
    expect((await req(app, "GET", `/agents/${id}`)).status).toBe(200);
  });
  test("should delete only the selected standalone or package profile", async () => {
    expect((await req(app, "DELETE", `/agents/${id}`)).status).toBe(204);
    expect((await req(app, "GET", `/agents/${id}`)).status).toBe(404);
    expect((await req(app, "DELETE", `/agents/${id}`)).status).toBe(404);
    const packageId = encodeURIComponent(`${name}/review`);
    expect((await req(app, "DELETE", `/agents/${packageId}`)).status).toBe(204);
    expect((await req(app, "GET", `/agents/${packageId}`)).status).toBe(404);
    expect((await req(app, "GET", `/agent-packages/${name}`)).status).toBe(200);
    const file = await req(app, "GET", `/agent-packages/${name}?ref=references%2Fpolicy.md`);
    expect((await file.json()).content).toBe("Shared policy");
    const library = JSON.parse(await executeTool("agent_list", {}));
    expect(
      library.agents.some(
        (agent: { id: string }) => agent.id === id || agent.id === `${name}/review`,
      ),
    ).toBe(false);
  });
});
