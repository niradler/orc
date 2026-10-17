import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resetConfig } from "@orc/core/config";

type QueryArgs = {
  prompt: string;
  options: {
    tools?: string[];
    mcpServers?: Record<string, { type: string; url: string; headers?: Record<string, string> }>;
    allowedTools?: string[];
    canUseTool: (name: string, input: Record<string, unknown>) => Promise<{ behavior: string }>;
  };
};

const queries: QueryArgs[] = [];
// mock.module is process-wide, so keep the real exports for other test files.
const actualSdk = await import("@anthropic-ai/claude-agent-sdk");
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  ...actualSdk,
  query: (args: QueryArgs) => {
    queries.push(args);
    return (async function* () {})();
  },
}));

const { buildOrcMcpServers } = await import("../orc-mcp.js");
const { createBackend } = await import("../index.js");

const ENV_KEYS = ["ORC_API_HOST", "ORC_API_PORT", "ORC_API_SECRET"] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv.set(k, process.env[k]);
  process.env.ORC_API_HOST = "127.0.0.1";
  process.env.ORC_API_PORT = "7755";
  process.env.ORC_API_SECRET = "s3cret";
  resetConfig();
  queries.length = 0;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfig();
});

describe("ORC MCP injection for tool-restricted sessions", () => {
  test("should build an http mcp server keyed orc with bearer auth", () => {
    expect(buildOrcMcpServers()).toEqual({
      orc: {
        type: "http",
        url: "http://127.0.0.1:7755/mcp",
        headers: { Authorization: "Bearer s3cret" },
      },
    });
  });

  test("should give the sdk backend the orc mcp server with every orc tool allowed", async () => {
    const backend = createBackend("claude");
    const session = await backend.startSession({
      cwd: process.cwd(),
      autoApprove: true,
      toolAllowlist: ["Read"],
    });
    await session.send("go");
    await Bun.sleep(20);
    expect(queries).toHaveLength(1);
    const { options } = queries[0] as QueryArgs;
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["orc"]);
    expect(options.tools).toEqual(["Read"]);
    expect(options.allowedTools).toEqual(["Read", "mcp__orc"]);
    for (const tool of ["flow_report", "job_run", "task_create", "skill_create"]) {
      expect((await options.canUseTool(`mcp__orc__${tool}`, {})).behavior).toBe("allow");
    }
    expect((await options.canUseTool("Read", {})).behavior).toBe("allow");
    expect((await options.canUseTool("Bash", {})).behavior).toBe("deny");
    expect((await options.canUseTool("mcp__orcx__job_run", {})).behavior).toBe("deny");
    expect((await options.canUseTool("mcp__github__create_issue", {})).behavior).toBe("deny");
    await session.close();
  });

  test("should give the cli backend only the orc mcp server via a private file", async () => {
    const claudePath = Bun.which("claude") ?? "claude";
    const whichSpy = spyOn(Bun, "which").mockReturnValue(claudePath);
    let cmd: string[] = [];
    let configJson = "";
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((o: { cmd: string[] }) => {
      cmd = o.cmd;
      const cfgPath = o.cmd[o.cmd.indexOf("--mcp-config") + 1] as string;
      configJson = readFileSync(cfgPath, "utf8");
      return {
        stdout: null,
        stderr: null,
        stdin: null,
        exitCode: 0,
        exited: Promise.resolve(0),
        kill: () => {},
      };
    }) as unknown as typeof Bun.spawn);
    try {
      const session = await createBackend("claude-cli").startSession({
        cwd: process.cwd(),
        toolAllowlist: ["Read"],
      });
      await session.send("go");
      await Bun.sleep(20);
      const at = (flag: string) => cmd[cmd.indexOf(flag) + 1];
      expect(at("--tools")).toBe("Read");
      expect(cmd).toContain("--strict-mcp-config");
      expect(at("--allowedTools")).toBe("mcp__orc");
      expect(cmd.join(" ")).not.toContain("s3cret");
      const parsed = JSON.parse(configJson) as {
        mcpServers: Record<string, unknown>;
      };
      expect(Object.keys(parsed.mcpServers)).toEqual(["orc"]);
      expect(parsed.mcpServers.orc).toEqual({
        type: "http",
        url: "http://127.0.0.1:7755/mcp",
        headers: { Authorization: "Bearer s3cret" },
      });
      expect(existsSync(at("--mcp-config") as string)).toBe(false);
    } finally {
      spawnSpy.mockRestore();
      whichSpy.mockRestore();
    }
  });

  test("should keep mcpAlwaysLoad on the orc server for restricted sessions", async () => {
    const session = await createBackend("claude").startSession({
      cwd: process.cwd(),
      autoApprove: true,
      toolAllowlist: ["Read", "mcp__orc__task_update"],
      mcpAlwaysLoad: true,
    });
    await session.send("go");
    await Bun.sleep(20);
    const { options } = queries[0] as QueryArgs;
    expect(options.tools).toEqual(["Read"]);
    expect(options.mcpServers?.orc).toHaveProperty("alwaysLoad", true);
    await session.close();
  });
});
