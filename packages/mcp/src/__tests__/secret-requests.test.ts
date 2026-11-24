import { afterAll, beforeAll, expect, test } from "bun:test";
import { resetConfig } from "@orc/core/config";
import { createTestDb, getSqlite } from "@orc/db/client";
import { HumanRequestStore } from "@orc/db/human-requests";
import { ProjectSecretStore } from "@orc/db/project-secrets";
import { executeTool } from "../tools.js";

const saved = {
  base: process.env.ORC_API_BASE,
  db: process.env.ORC_DB_PATH,
  active: process.env.ORC_ACTIVE_PROJECT,
};
let server: ReturnType<typeof Bun.serve>;
let store: HumanRequestStore;
let secrets: ProjectSecretStore;

beforeAll(() => {
  process.env.ORC_DB_PATH = ":memory:";
  process.env.ORC_ACTIVE_PROJECT = "";
  resetConfig();
  createTestDb();
  getSqlite().query("INSERT INTO projects(id,name) VALUES (?,?)").run("project-sec", "sec-app");
  store = new HumanRequestStore(getSqlite());
  secrets = new ProjectSecretStore(getSqlite());
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);
      if (request.method === "POST" && parts.at(-1) === "human-requests")
        return Response.json(store.create(await request.json()));
      if (request.method === "POST" && parts.at(-1) === "claim")
        return Response.json(store.claimSecret(parts.at(-2) ?? ""));
      if (request.method === "POST" && parts.at(-1) === "acknowledge") {
        const body = (await request.json()) as { version: number };
        return Response.json(store.acknowledge(parts.at(-2) ?? "", body.version));
      }
      if (request.method === "GET" && parts.at(-1) === "secrets") {
        return Response.json({ secrets: secrets.list(parts.at(-2) ?? "") });
      }
      return Response.json(store.get(parts.at(-1) ?? ""));
    },
  });
  process.env.ORC_API_BASE = String(server.url).replace(/\/$/, "");
});

afterAll(() => {
  server?.stop(true);
  for (const [key, value] of [
    ["ORC_API_BASE", saved.base],
    ["ORC_DB_PATH", saved.db],
    ["ORC_ACTIVE_PROJECT", saved.active],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfig();
});

test("human_request_get claims secret once with secret:true and returns consumed thereafter", async () => {
  const options = {
    projectScopes: [{ id: "project-sec", name: "sec-app" }],
    agentSessionId: "secret-mcp-sess",
  };
  const created = JSON.parse(
    await executeTool(
      "human_request",
      {
        kind: "secret",
        title: "API credentials",
        prompt: "Enter credentials",
        fields: [
          { key: "OPENAI_API_KEY", label: "OpenAI API key", required: true },
          { key: "BASE_URL", label: "Base URL", required: true },
        ],
        origin: { backend: "codex", session_id: "secret-mcp-sess", request_id: "sec-1" },
      },
      options,
    ),
  );
  expect(created.input.kind).toBe("secret");
  expect(created.input.project_id).toBe("project-sec");

  store.respond(created.id, created.version, {
    kind: "secret",
    values: { OPENAI_API_KEY: "sk-mcp-one-time-5511", BASE_URL: "https://api.test.local" },
    save_to_project: false,
  });

  const firstRead = JSON.parse(await executeTool("human_request_get", { id: created.id }, options));
  expect(firstRead.secret).toBe(true);
  expect(firstRead.secret_delivery).toEqual({
    status: "delivered",
    stored: false,
    values: { OPENAI_API_KEY: "sk-mcp-one-time-5511", BASE_URL: "https://api.test.local" },
  });

  const secondRead = JSON.parse(
    await executeTool("human_request_get", { id: created.id }, options),
  );
  expect(secondRead.secret).toBe(true);
  expect(secondRead.secret_delivery).toEqual({ status: "consumed" });
  expect(JSON.stringify(secondRead)).not.toContain("sk-mcp-one-time-5511");

  const acked = JSON.parse(
    await executeTool(
      "human_request_acknowledge",
      { id: created.id, version: firstRead.version },
      options,
    ),
  );
  expect(acked.status).toBe("delivered");
});

test("project_secret_list exposes metadata only and never values", async () => {
  secrets.upsert("project-sec", {
    name: "deploy-token",
    value: "tok-never-exposed-7744",
    description: "CI deploy token",
  });
  const options = {
    projectScopes: [{ id: "project-sec", name: "sec-app" }],
    agentSessionId: "secret-mcp-sess",
  };
  const raw = await executeTool("project_secret_list", { project: "sec-app" }, options);
  expect(raw).not.toContain("tok-never-exposed-7744");
  const parsed = JSON.parse(raw) as { secrets: Array<{ name: string; reference: string }> };
  expect(parsed.secrets).toHaveLength(1);
  expect(parsed.secrets[0]?.reference).toBe("project/deploy-token");
});
