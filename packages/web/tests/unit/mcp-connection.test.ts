import { expect, test } from "bun:test";
import { mcpBaseUrl, mcpSnippet, mcpUrl } from "../../src/lib/mcp-connection";

const base = {
  baseUrl: "http://localhost:7700/mcp",
  mode: "meta" as const,
  projects: [] as string[],
  name: "orc",
  secretEnv: "ORC_API_SECRET",
};

test("endpoint follows the configured API origin", () => {
  expect(mcpBaseUrl("/api", "http://localhost:3077")).toBe("http://localhost:3077/mcp");
  expect(mcpBaseUrl("https://orc.example.com/api", "http://localhost:3077")).toBe(
    "https://orc.example.com/mcp",
  );
});

test("query carries only non-default mode and the selected project scope", () => {
  expect(mcpUrl(base)).toBe("http://localhost:7700/mcp");
  expect(mcpUrl({ ...base, mode: "full", projects: ["orc"] })).toBe(
    "http://localhost:7700/mcp?mode=full&project=orc",
  );
  expect(mcpUrl({ ...base, projects: ["orc", "spec cli"] })).toBe(
    "http://localhost:7700/mcp?projects=orc%2Cspec+cli",
  );
});

test("snippets reference the secret env var and omit auth when there is none", () => {
  const scoped = { ...base, projects: ["orc"] };
  expect(JSON.parse(mcpSnippet("claude-json", scoped))).toEqual({
    mcpServers: {
      orc: {
        type: "http",
        url: "http://localhost:7700/mcp?project=orc",
        headers: { Authorization: `Bearer \${ORC_API_SECRET}` },
      },
    },
  });
  expect(mcpSnippet("claude-cli", scoped)).toBe(
    `claude mcp add --transport http orc 'http://localhost:7700/mcp?project=orc' --header 'Authorization: Bearer \${ORC_API_SECRET}'`,
  );
  expect(mcpSnippet("codex", scoped)).toBe(
    '[mcp_servers.orc]\nurl = "http://localhost:7700/mcp?project=orc"\nbearer_token_env_var = "ORC_API_SECRET"',
  );
  expect(mcpSnippet("spec", { ...scoped, secretEnv: "" })).toBe(
    "spec add orc --mcp-http 'http://localhost:7700/mcp?project=orc'",
  );
});
