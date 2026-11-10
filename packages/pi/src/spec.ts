import type { PorcConfig } from "./config.js";

export type SpecAction =
  | { action: "list"; filter?: string; limit?: number }
  | { action: "show"; operation: string }
  | { action: "call"; operation: string; data?: unknown };

export type SpecConfig = Pick<
  PorcConfig,
  "apiBase" | "mode" | "secret" | "secretSource" | "command"
>;

function quote(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

/** The ORC stdio server reads the API base, secret and project from its environment. */
function envArgs(
  config: SpecConfig,
  project: string | undefined,
  sessionId: string | undefined,
): string[] {
  const env: Array<[string, string]> = [["ORC_API_BASE", config.apiBase]];
  if (project) env.push(["ORC_ACTIVE_PROJECT", project]);
  if (sessionId) env.push(["ORC_SESSION_ID", sessionId]);
  // An ORC-config secret is already readable by the child; avoid putting it in argv again.
  if (config.secret && config.secretSource !== "orc") env.push(["ORC_API_SECRET", config.secret]);
  return env.flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

function sourceArgs(
  config: SpecConfig,
  project: string | undefined,
  sessionId: string | undefined,
): string[] {
  return [
    "--mcp-stdio",
    `${quote(config.command)} mcp --mode ${config.mode}`,
    ...envArgs(config, project, sessionId),
  ];
}

/** `spec` uses the same ORC stdio MCP connection, so operations and schemas cannot drift. */
export function buildSpecArgs(
  config: SpecConfig,
  project: string | undefined,
  input: SpecAction,
  sessionId?: string,
): string[] {
  if (input.action === "list") {
    return [
      "list",
      ...sourceArgs(config, project, sessionId),
      ...(input.filter ? ["--filter", input.filter] : []),
      ...(input.limit ? ["--limit", String(input.limit)] : []),
    ];
  }
  if (input.action === "show") {
    // Same variadic `--env` constraint as `call`.
    return [
      "show",
      "--mcp-stdio",
      `${quote(config.command)} mcp --mode ${config.mode}`,
      input.operation,
      ...envArgs(config, project, sessionId),
    ];
  }
  // `--env` is variadic, so the positional operation has to come before it or
  // commander reports that no non-option argument was supplied.
  return [
    "call",
    "--mcp-stdio",
    `${quote(config.command)} mcp --mode ${config.mode}`,
    input.operation,
    ...envArgs(config, project, sessionId),
    ...(input.data === undefined ? [] : ["--data", JSON.stringify(input.data)]),
  ];
}

export function buildSpecRegistration(
  config: SpecConfig,
  project?: string,
  sessionId?: string,
): string[] {
  return [
    "add",
    "orc",
    ...sourceArgs(config, project, sessionId),
    "--description",
    "ORC project context, memories, skills and tasks",
  ];
}

export type SpecExec = (
  command: string,
  args: string[],
  options?: { timeout?: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export async function runSpec(
  exec: SpecExec,
  config: SpecConfig & Pick<PorcConfig, "timeoutMs">,
  input: SpecAction,
  options: { project?: string; sessionId?: string; cwd?: string } = {},
): Promise<{ ok: boolean; output: string }> {
  const result = await exec(
    "spec",
    buildSpecArgs(config, options.project, input, options.sessionId),
    {
      timeout: Math.max(config.timeoutMs * 4, 15_000),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    },
  );
  const output = (result.stdout || result.stderr).trim();
  return { ok: result.code === 0, output };
}

export async function specAvailable(exec: SpecExec): Promise<boolean> {
  try {
    const result = await exec("spec", ["--help"], { timeout: 5000 });
    return result.code === 0;
  } catch {
    return false;
  }
}
