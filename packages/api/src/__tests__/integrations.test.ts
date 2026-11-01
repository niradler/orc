import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpecClient, setSpecHome } from "api-spec-cli";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "orc-spec-home-"));
  setSpecHome(home);
  app = setupTestApp();
});
afterAll(() => {
  teardownTestApp();
  setSpecHome(undefined);
  rmSync(home, { recursive: true, force: true });
});

test("lists spec-cli connections without exposing their credentials", async () => {
  expect((await app.request("/api/integrations/connections")).status).toBe(401);
  expect(await (await req(app, "GET", "/integrations/connections")).json<unknown>()).toEqual({
    connections: [],
  });

  const client = createSpecClient();
  client.specs.add("github", {
    type: "http",
    url: "https://mcp.example.com/mcp",
    auth: "literal-secret-token",
    headers: { "X-Api-Key": "literal-header-secret" },
  });
  await client.close();

  const response = await req(app, "GET", "/integrations/connections");
  const body = await response.text();
  expect(JSON.parse(body)).toEqual({
    connections: [{ name: "github", type: "http", description: null, enabled: true }],
  });
  expect(body).not.toContain("literal-");
  expect(body).not.toContain("mcp.example.com");
});

test("labels legacy entries without a type by their registry section", async () => {
  writeFileSync(
    join(home, "registry.json"),
    JSON.stringify({
      mcp: {},
      openapi: {},
      graphql: { hashnode: { source: "https://gql.example.com", description: "Hashnode" } },
    }),
  );
  expect(await (await req(app, "GET", "/integrations/connections")).json<unknown>()).toEqual({
    connections: [{ name: "hashnode", type: "graphql", description: "Hashnode", enabled: true }],
  });
});

test("creates, edits, disables and removes a connection, keeping secrets on the server side", async () => {
  writeFileSync(join(home, "registry.json"), JSON.stringify({ mcp: {}, openapi: {}, graphql: {} }));
  const source = {
    type: "http",
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: "Bearer literal-token" },
    description: "Example",
  };
  const created = await req(app, "POST", "/integrations/connections", { name: "example", source });
  expect(created.status).toBe(200);
  expect(await created.json<unknown>()).toEqual({ name: "example", enabled: true, source });
  expect(
    (await req(app, "POST", "/integrations/connections", { name: "example", source })).status,
  ).toBe(409);
  expect(
    (await req(app, "POST", "/integrations/connections", { name: "bad name", source })).status,
  ).toBe(400);

  expect(
    (await req(app, "PATCH", "/integrations/connections/example", { enabled: false })).status,
  ).toBe(200);
  const edited = { ...source, url: "https://mcp.example.com/v2" };
  const put = await req(app, "PUT", "/integrations/connections/example", { source: edited });
  // An edit keeps the connection disabled; `spec add` alone would re-enable it.
  expect(await put.json<unknown>()).toEqual({ name: "example", enabled: false, source: edited });
  expect(
    await (await req(app, "GET", "/integrations/connections/example")).json<unknown>(),
  ).toEqual({ name: "example", enabled: false, source: edited });

  expect((await req(app, "DELETE", "/integrations/connections/example")).status).toBe(204);
  expect((await req(app, "GET", "/integrations/connections/example")).status).toBe(404);
  expect(
    (await req(app, "PUT", "/integrations/connections/example", { source: edited })).status,
  ).toBe(404);
});

test("lists, toggles, describes and invokes a connection's tools", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => Response.json({ pet: new URL(request.url).pathname }),
  });
  try {
    const specPath = join(home, "pets.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Pets", version: "1" },
        paths: {
          "/pets/{id}": {
            get: {
              operationId: "getPet",
              summary: "Get a pet",
              parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            },
            delete: { operationId: "deletePet", summary: "Delete a pet" },
          },
        },
      }),
    );
    const source = {
      type: "openapi",
      source: specPath,
      baseUrl: `http://127.0.0.1:${server.port}`,
    };
    expect(
      (await req(app, "POST", "/integrations/connections", { name: "pets", source })).status,
    ).toBe(200);

    const base = "/integrations/connections/pets/tools";
    expect(await (await req(app, "GET", base)).json<unknown>()).toEqual({
      tools: [
        { id: "getPet", description: "Get a pet", enabled: true },
        { id: "deletePet", description: "Delete a pet", enabled: true },
      ],
    });

    expect(
      await (await req(app, "PATCH", `${base}/deletePet`, { enabled: false })).json<unknown>(),
    ).toEqual({ id: "deletePet", enabled: false });
    const tools = await (await req(app, "GET", base)).json<{ tools: { enabled: boolean }[] }>();
    expect(tools.tools.map((tool) => tool.enabled)).toEqual([true, false]);
    const blocked = await req(app, "POST", `${base}/deletePet/invoke`, {
      args: { path: { id: "1" } },
    });
    expect(blocked.status).toBe(404);
    // A disabled tool can still be described, so it can be reviewed before re-enabling it.
    expect((await req(app, "GET", `${base}/deletePet`)).status).toBe(200);

    const described = await (await req(app, "GET", `${base}/getPet`)).json<unknown>();
    expect(described).toMatchObject({
      id: "getPet",
      description: "Get a pet",
      enabled: true,
      inputSchema: { properties: { path: { properties: { id: { type: "string" } } } } },
    });

    const result = await req(app, "POST", `${base}/getPet/invoke`, {
      args: { path: { id: "7" } },
    });
    expect(result.status).toBe(200);
    expect(JSON.stringify(await result.json<unknown>())).toContain("/pets/7");
  } finally {
    server.stop(true);
  }
});

test("tests an unsaved connection without registering it", async () => {
  const before = await (await req(app, "GET", "/integrations/connections")).json<unknown>();
  const test = (name: string, source: Record<string, unknown>) =>
    req(app, "POST", "/integrations/connections/test", { name, source }).then((response) =>
      response.json<{ status: string; count: number | null; message: string | null }>(),
    );

  const fixture = join(import.meta.dir, "fixtures", "mcp-features-server.ts");
  expect(
    await test("draft", { type: "stdio", command: process.execPath, args: [fixture] }),
  ).toEqual({ status: "connected", count: expect.any(Number), message: null });

  const missing = await test("draft", { type: "openapi", source: join(home, "missing.json") });
  expect(missing.status).toBe("failed");
  expect(missing.message).toBeTruthy();

  // An OAuth server without stored tokens: the test reports it instead of opening a browser.
  const oauth = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const { pathname, origin } = new URL(request.url);
      if (pathname === "/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        });
      if (pathname === "/register")
        return Response.json(
          { ...((await request.json()) as object), client_id: "draft-client" },
          { status: 201 },
        );
      if (pathname.startsWith("/.well-known")) return new Response(null, { status: 404 });
      return new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
    },
  });
  try {
    const result = await test("draft", {
      type: "http",
      url: `http://127.0.0.1:${oauth.port}/mcp`,
      oauthClientSecret: "never-stored",
    });
    expect(result.status).toBe("auth_required");
  } finally {
    oauth.stop(true);
  }

  expect(await (await req(app, "GET", "/integrations/connections")).json<unknown>()).toEqual(
    before,
  );
  expect(
    (await req(app, "POST", "/integrations/connections/test", { name: "bad name", source: {} }))
      .status,
  ).toBe(400);
}, 30_000);

test("signs a remote MCP connection in through the browser redirect and out again", async () => {
  const tokenRequests: URLSearchParams[] = [];
  const oauth = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const { pathname, origin } = new URL(request.url);
      if (pathname === "/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        });
      if (pathname === "/register")
        return Response.json(
          { ...((await request.json()) as object), client_id: "orc-client" },
          { status: 201 },
        );
      if (pathname === "/token") {
        tokenRequests.push(new URLSearchParams(await request.text()));
        return Response.json({ access_token: "access", token_type: "Bearer", expires_in: 3600 });
      }
      if (pathname.startsWith("/.well-known")) return new Response(null, { status: 404 });
      return new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
    },
  });
  try {
    const source = { type: "http", url: `http://127.0.0.1:${oauth.port}/mcp` };
    expect(
      (await req(app, "POST", "/integrations/connections", { name: "remote", source })).status,
    ).toBe(200);
    const base = "/integrations/connections/remote/authorize";
    const redirectUrl = "https://orc.example.com/integrations/oauth/remote/callback";
    const start = await req(app, "POST", base, { redirectUrl });
    const { status, authorizationUrl } = await start.json<{
      status: string;
      authorizationUrl: string;
    }>();
    expect(status).toBe("redirect");
    const authorize = new URL(authorizationUrl).searchParams;
    expect(authorize.get("redirect_uri")).toBe(redirectUrl);
    expect(authorize.get("client_id")).toBe("orc-client");
    const state = authorize.get("state") ?? "";

    expect(
      (await req(app, "POST", `${base}/callback`, { code: "c", state: "forged" })).status,
    ).toBe(400);
    expect((await req(app, "POST", `${base}/callback`, { code: "c", state })).status).toBe(204);
    expect(tokenRequests.at(-1)?.get("code")).toBe("c");
    expect(tokenRequests.at(-1)?.get("redirect_uri")).toBe(redirectUrl);
    // The state is single-use.
    expect((await req(app, "POST", `${base}/callback`, { code: "c", state })).status).toBe(400);

    expect((await req(app, "DELETE", base)).status).toBe(204);
    expect((await req(app, "POST", base, { redirectUrl: "not a url" })).status).toBe(400);
    expect(
      (await req(app, "POST", "/integrations/connections/missing/authorize", { redirectUrl }))
        .status,
    ).toBe(404);
    expect((await req(app, "DELETE", "/integrations/connections/remote")).status).toBe(204);
  } finally {
    oauth.stop(true);
  }
}, 30_000);

test("lists, toggles, reads and renders an MCP connection's resources and prompts", async () => {
  const fixture = join(import.meta.dir, "fixtures", "mcp-features-server.ts");
  const source = { type: "stdio", command: process.execPath, args: [fixture] };
  expect(
    (await req(app, "POST", "/integrations/connections", { name: "docs", source })).status,
  ).toBe(200);
  const base = "/integrations/connections/docs";

  expect(await (await req(app, "GET", `${base}/tools`)).json<unknown>()).toEqual({
    tools: [{ id: "ping", description: "Ping", enabled: true }],
  });
  expect(await (await req(app, "GET", `${base}/resources`)).json<unknown>()).toEqual({
    resources: [
      {
        uri: "docs://readme",
        name: "readme",
        description: "The readme",
        mimeType: "text/markdown",
        enabled: true,
      },
      {
        uri: "docs://secret",
        name: "secret",
        description: "Hidden by a filter",
        mimeType: null,
        enabled: true,
      },
    ],
    templates: [
      {
        uriTemplate: "docs://pages/{slug}",
        name: "page",
        description: "A page by slug",
        mimeType: null,
        enabled: true,
      },
    ],
    error: null,
  });
  expect(await (await req(app, "GET", `${base}/prompts`)).json<unknown>()).toEqual({
    prompts: [
      {
        name: "summarize",
        description: "Summarize a topic",
        arguments: [{ name: "topic", description: "The topic", required: true }],
        enabled: true,
      },
    ],
    error: null,
  });

  const read = await req(app, "POST", `${base}/resources/read`, { uri: "docs://readme" });
  expect(await read.json<unknown>()).toEqual({
    contents: [{ uri: "spec://docs/docs://readme", mimeType: "text/markdown", text: "# Docs" }],
  });
  const page = await req(app, "POST", `${base}/resources/read`, {
    uri: "docs://pages/{slug}",
    vars: { slug: "intro" },
  });
  expect(JSON.stringify(await page.json<unknown>())).toContain("page intro");
  const rendered = await req(app, "POST", `${base}/prompts/get`, {
    prompt: "summarize",
    arguments: { topic: "billing" },
  });
  expect(await rendered.json<unknown>()).toEqual({
    messages: [{ role: "user", content: { type: "text", text: "Summarize billing" } }],
  });

  // Resources and prompts toggle through the tool filter under their spec-cli IDs.
  const secret = encodeURIComponent("resource:docs://secret");
  expect((await req(app, "PATCH", `${base}/tools/${secret}`, { enabled: false })).status).toBe(200);
  expect(
    (await req(app, "PATCH", `${base}/tools/prompt%3Asummarize`, { enabled: false })).status,
  ).toBe(200);
  const resources = await (await req(app, "GET", `${base}/resources`)).json<{
    resources: { enabled: boolean }[];
  }>();
  expect(resources.resources.map((resource) => resource.enabled)).toEqual([true, false]);
  const prompts = await (await req(app, "GET", `${base}/prompts`)).json<{
    prompts: { enabled: boolean }[];
  }>();
  expect(prompts.prompts[0]?.enabled).toBe(false);
  expect((await req(app, "POST", `${base}/resources/read`, { uri: "docs://secret" })).status).toBe(
    404,
  );
  expect(
    (await req(app, "POST", `${base}/prompts/get`, { prompt: "summarize", arguments: {} })).status,
  ).toBe(404);
  expect((await req(app, "DELETE", base)).status).toBe(204);
}, 30_000);
