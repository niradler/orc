import { afterAll, beforeAll, expect, test } from "bun:test";
import { resetConfig } from "@orc/core/config";
import { createTestDb, getSqlite } from "@orc/db/client";
import { HumanRequestStore } from "@orc/db/human-requests";
import { executeTool } from "../tools.js";

const saved = {
  base: process.env.ORC_API_BASE,
  db: process.env.ORC_DB_PATH,
  active: process.env.ORC_ACTIVE_PROJECT,
};
let server: ReturnType<typeof Bun.serve>;
let store: HumanRequestStore;
beforeAll(() => {
  process.env.ORC_DB_PATH = ":memory:";
  process.env.ORC_ACTIVE_PROJECT = "";
  resetConfig();
  createTestDb();
  getSqlite().query("INSERT INTO projects(id,name) VALUES (?,?)").run("project-a", "human-a");
  store = new HumanRequestStore(getSqlite());
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const parts = new URL(request.url).pathname.split("/");
      if (request.method === "POST" && parts.at(-1) === "human-requests")
        return Response.json(store.create(await request.json()));
      if (parts.at(-1) === "acknowledge") {
        const body = (await request.json()) as { version: number };
        return Response.json(store.acknowledge(parts.at(-2) ?? "", body.version));
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

test("should continue explicit MCP requests with project and origin binding and acknowledge only after consumption", async () => {
  const options = {
    projectScopes: [{ id: "project-a", name: "human-a" }],
    agentSessionId: "origin",
  };
  const input = {
    kind: "question",
    prompt: "Pick",
    origin: { backend: "external", session_id: "origin", request_id: "mcp" },
  };
  const request = JSON.parse(await executeTool("human_request", input, options));
  expect(request.input.project_id).toBe("project-a");
  expect(
    JSON.parse(await executeTool("human_request_get", { id: request.id }, options)).status,
  ).toBe("pending");
  await expect(
    executeTool("human_request_get", { id: request.id }, { agentSessionId: "wrong" }),
  ).rejects.toThrow("another agent");
  await expect(
    executeTool(
      "human_request_get",
      { id: request.id },
      { projectScopes: [{ id: "wrong", name: "other" }] },
    ),
  ).rejects.toThrow("outside");
  const waiting = executeTool("human_request_get", { id: request.id, wait_seconds: 2 }, options);
  store.respond(request.id, 1, { kind: "question", answer: "Blue" });
  expect(JSON.parse(await waiting).response).toEqual({ kind: "question", answer: "Blue" });
  expect(
    JSON.parse(
      await executeTool("human_request_acknowledge", { id: request.id, version: 2 }, options),
    ).status,
  ).toBe("delivered");
  await expect(
    executeTool(
      "human_request",
      { ...input, origin: { ...input.origin, session_id: "wrong" } },
      options,
    ),
  ).rejects.toThrow("calling agent");
});

test("should deliver command results only to the requesting MCP workflow", async () => {
  const options = {
    agentSessionId: "command-session",
    projectScopes: [{ id: "project-a", name: "human-a" }],
  };
  const input = {
    title: "Connect to the service",
    prompt: "Run a user supplied command",
    origin: { backend: "external", session_id: "command-session", request_id: "mcp-command" },
    command: {
      host: null,
      cwd: "/tmp",
      script: 'printf "%s" "$ORC_INPUT_TOKEN"',
      arguments: [{ name: "TOKEN", label: "Token", description: "Used only by the login command" }],
    },
  };
  const request = JSON.parse(await executeTool("command_request", input, options));
  expect(
    JSON.parse(await executeTool("human_request", { ...input, kind: "command" }, options)).id,
  ).toBe(request.id);
  expect(request.input.title).toBe(input.title);
  expect(request.input.command.arguments[0].description).toContain("login command");
  expect(request.input.kind).toBe("command");
  expect(request.input.project_id).toBe("project-a");
  await expect(
    executeTool("human_request_get", { id: request.id }, { agentSessionId: "other-session" }),
  ).rejects.toThrow("another agent");
  const claimed = store.claimCommand(request.id, request.version);
  const waiting = executeTool("human_request_get", { id: request.id, wait_seconds: 2 }, options);
  store.completeCommand(request.id, claimed.version, {
    kind: "command",
    exit_code: 0,
    stdout: "[REDACTED]",
    stderr: "",
    truncated: false,
  });
  const delivered = JSON.parse(await waiting);
  expect(delivered.response.stdout).toBe("[REDACTED]");
  expect(
    JSON.parse(
      await executeTool(
        "human_request_acknowledge",
        { id: request.id, version: delivered.version },
        options,
      ),
    ).status,
  ).toBe("delivered");
});
