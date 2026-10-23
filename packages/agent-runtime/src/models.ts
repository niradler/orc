import { ChatModelSchema } from "@orc/core/chat";
import { type ExecHost, hostBinary, hostSpawn } from "@orc/core/exec-host";
import { resolveClaudeSdkLaunch } from "./claude-executable.js";
import { resolveCodexLaunch } from "./codex.js";
import { endStdin, writeToStdin } from "./io.js";

export interface AgentModel {
  id: string;
  label: string;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function parseAgentModels(value: unknown, agent: string): AgentModel[] {
  if (!Array.isArray(value)) throw new Error("The agent returned no model catalog.");
  const models = new Map<string, AgentModel>();
  for (const item of value.slice(0, 500)) {
    const row = object(item);
    if (!row || row.hidden === true) continue;
    const parsed = ChatModelSchema.safeParse(
      agent === "claude" ? row.value : (row.model ?? row.id),
    );
    if (!parsed.success || !parsed.data) continue;
    const label =
      typeof row.displayName === "string"
        ? Array.from(row.displayName)
            .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
            .join("")
            .slice(0, 120)
        : parsed.data;
    models.set(parsed.data, { id: parsed.data, label: label || parsed.data });
  }
  return [...models.values()];
}

/** Metadata handshake only: never sends a user prompt or starts an inference turn. */
export async function discoverAgentModels(
  agent: string,
  host: ExecHost,
  cwd: string,
): Promise<AgentModel[]> {
  if (agent !== "codex" && agent !== "claude") return [];
  const binary = await hostBinary(host, agent);
  if (!binary) throw new Error("The selected agent is not installed on its execution host.");
  let command = [binary];
  if (host.kind === "local") {
    if (agent === "codex") command = resolveCodexLaunch(binary);
    else {
      const launch = resolveClaudeSdkLaunch(true);
      command = [
        ...(launch.executable ? [launch.executable] : []),
        launch.pathToClaudeCodeExecutable ?? binary,
      ];
    }
  }
  return readAgentModelCatalog(
    agent,
    host,
    [
      ...command,
      ...(agent === "codex"
        ? ["app-server", "--listen", "stdio://"]
        : [
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
            "--settings",
            '{"disableAllHooks":true}',
          ]),
    ],
    cwd,
  );
}

export async function readAgentModelCatalog(
  agent: string,
  host: ExecHost,
  command: string[],
  cwd: string,
): Promise<AgentModel[]> {
  const child = await hostSpawn(host, command, { cwd, stdin: "pipe", stderr: "ignore" });
  const send = (value: unknown) =>
    writeToStdin(child.proc.stdin, new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  const stdout = child.proc.stdout;
  if (!stdout || typeof stdout === "number") {
    child.kill();
    throw new Error("The agent model discovery stream is unavailable.");
  }
  const reader = stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async () => {
      send(
        agent === "codex"
          ? {
              id: 1,
              method: "initialize",
              params: { clientInfo: { name: "orc-model-picker", version: "1" } },
            }
          : { type: "control_request", request_id: "models", request: { subtype: "initialize" } },
      );
      const decoder = new TextDecoder();
      let buffer = "";
      let bytes = 0;
      let requestId = 2;
      const models: AgentModel[] = [];
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("The agent closed before returning its model catalog.");
        bytes += chunk.value.byteLength;
        if (bytes > 1024 * 1024)
          throw new Error("The agent model catalog exceeded its size limit.");
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          let message: Record<string, unknown> | null;
          try {
            message = object(JSON.parse(line));
          } catch {
            continue;
          }
          if (!message) continue;
          if (agent === "claude") {
            const response = object(message.response);
            if (message.type !== "control_response" || response?.request_id !== "models") continue;
            if (response.subtype !== "success")
              throw new Error("The agent could not list its models.");
            return parseAgentModels(object(response.response)?.models, agent);
          }
          if (message.id !== 1 && message.id !== requestId) continue;
          if (message.error) throw new Error("The agent could not list its models.");
          if (message.id === 1) {
            send({ method: "initialized", params: {} });
            send({
              id: requestId,
              method: "model/list",
              params: { limit: 100, includeHidden: false },
            });
          } else {
            const result = object(message.result);
            models.push(...parseAgentModels(result?.data, agent));
            if (!result?.nextCursor) return models;
            if (requestId >= 11 || typeof result.nextCursor !== "string")
              throw new Error("The agent model catalog has too many pages.");
            requestId++;
            send({
              id: requestId,
              method: "model/list",
              params: { limit: 100, includeHidden: false, cursor: result.nextCursor },
            });
          }
        }
      }
    };
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Agent model discovery timed out.")), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    endStdin(child.proc.stdin);
    child.kill();
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
