import { describe, expect, test } from "bun:test";
import { buildSpecArgs, buildSpecRegistration, runSpec } from "../src/spec.js";

const config = {
  apiBase: "http://127.0.0.1:7700",
  mode: "meta" as const,
  secret: "s3cret",
  secretSource: "env" as const,
  command: "orc",
};

function firstEnvIndex(args: string[]): number {
  return args.indexOf("--env");
}

describe("buildSpecArgs", () => {
  test("list carries the source, filter and limit", () => {
    const args = buildSpecArgs(
      config,
      "orc",
      { action: "list", filter: "task", limit: 5 },
      "ses_1",
    );
    expect(args[0]).toBe("list");
    expect(args).toContain("--mcp-stdio");
    expect(args).toContain("orc mcp --mode meta");
    expect(args).toEqual(
      expect.arrayContaining([
        "--filter",
        "task",
        "--limit",
        "5",
        "--env",
        "ORC_API_BASE=http://127.0.0.1:7700",
        "--env",
        "ORC_ACTIVE_PROJECT=orc",
        "--env",
        "ORC_SESSION_ID=ses_1",
        "--env",
        "ORC_API_SECRET=s3cret",
      ]),
    );
  });

  test("show puts the operation before the variadic --env", () => {
    const args = buildSpecArgs(config, "orc", { action: "show", operation: "context" });
    expect(args[0]).toBe("show");
    expect(args.indexOf("context")).toBeGreaterThan(0);
    expect(args.indexOf("context")).toBeLessThan(firstEnvIndex(args));
  });

  test("call puts the operation before the variadic --env and data last", () => {
    const args = buildSpecArgs(config, "orc", {
      action: "call",
      operation: "tool_invoke",
      data: { name: "project_list", arguments: {} },
    });

    expect(args[0]).toBe("call");
    expect(args).toContain("tool_invoke");
    expect(args.indexOf("tool_invoke")).toBeLessThan(firstEnvIndex(args));
    expect(args.slice(-2)).toEqual([
      "--data",
      JSON.stringify({ name: "project_list", arguments: {} }),
    ]);
  });

  test("omits the secret when ORC already reads it from its own config", () => {
    const args = buildSpecArgs({ ...config, secretSource: "orc" }, "orc", { action: "list" });
    expect(args).not.toContain("ORC_API_SECRET=s3cret");
  });

  test("quotes commands that contain spaces", () => {
    const args = buildSpecArgs({ ...config, command: "C:/Program Files/orc/orc.exe" }, undefined, {
      action: "list",
    });
    expect(args).toContain('"C:/Program Files/orc/orc.exe" mcp --mode meta');
  });
});

test("buildSpecRegistration registers the ORC source for every agent", () => {
  expect(buildSpecRegistration(config, "orc", "ses_1")).toEqual([
    "add",
    "orc",
    "--mcp-stdio",
    "orc mcp --mode meta",
    "--env",
    "ORC_API_BASE=http://127.0.0.1:7700",
    "--env",
    "ORC_ACTIVE_PROJECT=orc",
    "--env",
    "ORC_SESSION_ID=ses_1",
    "--env",
    "ORC_API_SECRET=s3cret",
    "--description",
    "ORC project context, memories, skills and tasks",
  ]);
});

test("runSpec returns combined output and honors the exit code", async () => {
  const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
  const exec = async (
    command: string,
    args: string[],
    options?: { timeout?: number; cwd?: string },
  ) => {
    calls.push({ command, args, options });
    return { stdout: " output \n", stderr: "", code: 0 };
  };

  const result = await runSpec(
    exec,
    { ...config, timeoutMs: 1000 },
    { action: "call", operation: "context", data: {} },
    { project: "orc", sessionId: "ses_1", cwd: "C:/work/app" },
  );

  expect(result).toEqual({ ok: true, output: "output" });
  expect(calls[0]?.command).toBe("spec");
  expect(calls[0]?.options).toEqual({ timeout: 15_000, cwd: "C:/work/app" });

  const failed = await runSpec(
    async () => ({ stdout: "", stderr: "boom", code: 1 }),
    { ...config, timeoutMs: 1000 },
    { action: "list" },
  );
  expect(failed).toEqual({ ok: false, output: "boom" });
});
