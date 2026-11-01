import { expect, test } from "bun:test";
import type { IntegrationConnectionSource } from "@orc/sdk/types";
import {
  authModesFor,
  connectionTypeLabel,
  draftError,
  emptyDraft,
  isSecretKey,
  toDraft,
  toSource,
} from "../../src/lib/connection-source";

const roundTrip = (source: IntegrationConnectionSource) =>
  JSON.parse(JSON.stringify(toSource(toDraft(source))));

test("every connection type round-trips through the form", () => {
  const sources: IntegrationConnectionSource[] = [
    {
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer x", "X-Team": "core" },
      oauthFlow: "device",
      oauthClientId: "client",
      oauthCallbackPort: 8765,
      description: "Example",
      disabledTools: ["delete_*"],
    },
    { type: "sse", url: "https://mcp.example.com/sse" },
    {
      type: "stdio",
      command: "npx",
      args: ["-y", "server name, with comma"],
      cwd: "/work",
      env: { API_KEY: `\${KEY}` },
      allowedTools: ["read_*", "list_*"],
    },
    {
      type: "openapi",
      source: "https://api.example.com/openapi.json",
      baseUrl: "https://api.example.com",
      auth: `\${TOKEN}`,
    },
    { type: "graphql", source: "https://gql.example.com", headers: { "X-Key": "k" } },
  ];
  for (const source of sources) expect(roundTrip(source)).toEqual(source);
});

test("blank fields and empty rows are dropped from the saved source", () => {
  expect(
    JSON.parse(
      JSON.stringify(
        toSource({
          ...emptyDraft,
          url: " https://x/mcp ",
          description: "  ",
          headers: [{ key: " ", value: "orphan" }],
          oauthClientSecret: "",
          allowedTools: "\n",
        }),
      ),
    ),
  ).toEqual({ type: "http", url: "https://x/mcp" });
});

test("validation names the missing field for the chosen type", () => {
  expect(draftError("bad name", { ...emptyDraft, url: "https://x" })).toContain("Name");
  expect(draftError("ok", emptyDraft)).toBe("URL is required.");
  expect(draftError("ok", { ...emptyDraft, type: "stdio" })).toBe("Command is required.");
  expect(draftError("ok", { ...emptyDraft, type: "graphql" })).toBe(
    "Spec URL or file is required.",
  );
  expect(draftError("ok", { ...emptyDraft, url: "https://x", authMode: "token" })).toBe(
    "Token is required.",
  );
  expect(
    draftError("ok", {
      ...emptyDraft,
      url: "https://x",
      authMode: "oauth",
      oauthFlow: "client_credentials",
    }),
  ).toContain("client ID");
  expect(draftError("ok", { ...emptyDraft, url: "https://x", authMode: "oauth" })).toBeNull();
  expect(draftError("ok", { ...emptyDraft, url: "https://x" })).toBeNull();
});

test("the auth mode is read from the source and only its fields are saved", () => {
  expect(toDraft({ type: "http", url: "u", oauthCallbackPort: 9000 }).authMode).toBe("oauth");
  expect(toDraft({ type: "openapi", source: "s", auth: "t" }).authMode).toBe("token");
  expect(toDraft({ type: "graphql", source: "s" }).authMode).toBe("none");

  const oauth = { ...emptyDraft, url: "https://x", auth: "stale", oauthClientId: "id" };
  expect(JSON.parse(JSON.stringify(toSource({ ...oauth, authMode: "none" })))).toEqual({
    type: "http",
    url: "https://x",
  });
  expect(toSource({ ...oauth, authMode: "token" })).toMatchObject({ auth: "stale" });
  // A secret is only sent for the client-credentials flow; sign-in flows use PKCE.
  const signIn = { ...oauth, authMode: "oauth" as const, oauthClientSecret: "s" };
  expect(toSource(signIn)).toMatchObject({ oauthClientId: "id", oauthClientSecret: undefined });
  expect(toSource({ ...signIn, oauthFlow: "client_credentials" })).toMatchObject({
    oauthClientSecret: "s",
  });
  // The callback port is hidden in the form, but a stored one survives an edit.
  expect(roundTrip({ type: "http", url: "u", oauthCallbackPort: 9000 })).toEqual({
    type: "http",
    url: "u",
    oauthCallbackPort: 9000,
  });
});

test("OAuth is offered only for remote MCP servers", () => {
  expect(authModesFor("http").map((mode) => mode.value)).toEqual(["none", "token", "oauth"]);
  expect(authModesFor("openapi").map((mode) => mode.value)).toEqual(["none", "token"]);
  expect(authModesFor("stdio")).toEqual([]);
});

test("credential-looking names are masked and types get readable labels", () => {
  expect(["Authorization", "X-Api-Key", "GITHUB_TOKEN", "Cookie"].every(isSecretKey)).toBe(true);
  expect(["Accept", "X-Team", "NODE_ENV"].some(isSecretKey)).toBe(false);
  expect(connectionTypeLabel("graphql")).toBe("GraphQL");
  expect(connectionTypeLabel(null)).toBe("Unknown");
});
