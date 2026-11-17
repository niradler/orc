import { type ChatAgentCommand, ChatModelSchema } from "@orc/core/chat";
import { supportsModelDiscovery } from "@orc/core/coding-agents";
import { type ExecHost, hostBinary, hostSpawn } from "@orc/core/exec-host";
import {
  providerExecutable,
  providerForAgent,
  providerProcessEnvironment,
  resolveProviderEnvironment,
} from "@orc/core/provider-service";
import { z } from "zod";
import { type AcpEffortChoice, probeOpenCodeEffortChoices } from "./acp.js";
import { resolveClaudeSdkLaunch } from "./claude-executable.js";
import { resolveCodexLaunch } from "./codex.js";
import { endStdin, writeToStdin } from "./io.js";
import { piCommand } from "./pi.js";
import { PiRpc } from "./pi-rpc.js";

export interface AgentModel {
  id: string;
  label: string;
}

/** Live effort levels for a new OpenCode chat; null when the agent exposes none. */
export async function discoverOpenCodeEffortChoices(
  host: ExecHost,
  cwd: string,
  providerId?: string,
): Promise<AcpEffortChoice[] | null> {
  const profile = providerForAgent("opencode", providerId, true);
  const executable = providerExecutable(profile);
  return probeOpenCodeEffortChoices({
    cwd,
    executionHost: host.kind === "ssh" ? host.alias : null,
    ...(executable ? { providerExecutable: executable } : {}),
    env: resolveProviderEnvironment(profile).env,
  });
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
    if (agent === "pi" && (typeof row.provider !== "string" || typeof row.id !== "string"))
      continue;
    const parsed = ChatModelSchema.safeParse(
      agent === "claude"
        ? row.value
        : agent === "pi"
          ? `${row.provider}/${row.id}`
          : (row.model ?? row.id),
    );
    if (!parsed.success || !parsed.data) continue;
    const label =
      typeof (row.displayName ?? row.name) === "string"
        ? Array.from(String(row.displayName ?? row.name))
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
  providerId?: string,
): Promise<AgentModel[]> {
  if (!supportsModelDiscovery(agent)) return [];
  const profile = providerForAgent(agent, providerId, true);
  if (agent === "pi") {
    const environment = resolveProviderEnvironment(profile).env;
    const executable = providerExecutable(profile);
    const command = await piCommand({
      executionHost: host.kind === "ssh" ? host.alias : null,
      ...(executable ? { providerExecutable: executable } : {}),
    });
    const rpc = await PiRpc.start(
      host,
      [
        ...command,
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-mcp",
        "--no-approve",
      ],
      cwd,
      environment,
    );
    try {
      const catalog = z
        .object({
          models: z.array(
            z
              .object({ id: z.string(), provider: z.string(), name: z.string().optional() })
              .passthrough(),
          ),
        })
        .parse((await rpc.request({ type: "get_available_models" }, 15_000)).data);
      return parseAgentModels(catalog.models, "pi");
    } finally {
      await rpc.close();
    }
  }
  const command = await agentCommand(agent, host, profile);
  const environment = resolveProviderEnvironment(profile).env;
  // `opencode models` prints a plain `provider/model` list; no protocol handshake exists.
  if (agent === "opencode")
    return readTextModelCatalog(host, [...command, "models"], cwd, environment);
  return readAgentModelCatalog(
    agent,
    host,
    [...command, ...agentProtocolArgs(agent)],
    cwd,
    environment,
  );
}

async function agentCommand(
  agent: string,
  host: ExecHost,
  profile: ReturnType<typeof providerForAgent>,
): Promise<string[]> {
  const custom = host.kind === "local" ? providerExecutable(profile) : undefined;
  const binary = custom ? Bun.which(custom) : await hostBinary(host, agent);
  if (!binary) throw new Error("The selected agent is not installed on its execution host.");
  if (host.kind !== "local" || agent === "opencode") return [binary];
  if (agent === "codex") return resolveCodexLaunch(binary);
  const launch = resolveClaudeSdkLaunch(true, (name) =>
    name === "claude" ? binary : Bun.which(name),
  );
  return [
    ...(launch.executable ? [launch.executable] : []),
    launch.pathToClaudeCodeExecutable ?? binary,
  ];
}

function agentProtocolArgs(agent: string): string[] {
  return agent === "codex"
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
      ];
}

export async function discoverAgentCommands(
  agent: string,
  host: ExecHost,
  cwd: string,
  providerId?: string,
): Promise<ChatAgentCommand[]> {
  if (agent !== "claude" && agent !== "codex") return [];
  const profile = providerForAgent(agent, providerId, true);
  return readAgentCatalog(
    "commands",
    agent,
    host,
    [...(await agentCommand(agent, host, profile)), ...agentProtocolArgs(agent)],
    cwd,
    resolveProviderEnvironment(profile).env,
  );
}

function printable(value: unknown, max: number): string {
  return typeof value === "string"
    ? Array.from(value)
        .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
        .join("")
        .slice(0, max)
    : "";
}

export function parseAgentCommands(value: unknown, agent: string): ChatAgentCommand[] {
  if (!Array.isArray(value)) throw new Error("The agent returned no command catalog.");
  const commands = new Map<string, ChatAgentCommand>();
  for (const item of value.slice(0, 1000)) {
    const row = object(item);
    const name = printable(row?.name, 200);
    if (!row || row.enabled === false || !/^[\p{L}\p{N}][\p{L}\p{N}_:.-]*$/u.test(name)) continue;
    let description = printable(row.description, 1000);
    let source: string;
    if (agent === "codex") {
      source = printable(row.pluginId, 120).split("@")[0] || printable(row.scope, 120) || agent;
    } else {
      const plugin = name.includes(":") ? (name.split(":")[0] ?? "") : "";
      const lead = /^\(([^()]+)\) /.exec(description);
      if (lead && lead[1] === plugin) description = description.slice(lead[0].length);
      const tail = /\s*\((user|project|claude\.ai sync)\)$/.exec(description);
      if (tail) description = description.slice(0, tail.index);
      source = plugin || tail?.[1] || agent;
    }
    commands.set(name, {
      name,
      token: `${agent === "codex" ? "$" : "/"}${name}`,
      description,
      argumentHint: printable(row.argumentHint, 500),
      aliases: Array.isArray(row.aliases)
        ? row.aliases
            .map((alias) => printable(alias, 200))
            .filter(Boolean)
            .slice(0, 20)
        : [],
      source,
    });
  }
  return [...commands.values()];
}

/** Reads a model catalog printed as plain text, one model id per line. */
export async function readTextModelCatalog(
  host: ExecHost,
  command: string[],
  cwd: string,
  environment: Record<string, string> = {},
): Promise<AgentModel[]> {
  const child = await hostSpawn(host, command, {
    cwd,
    stdin: "pipe",
    stderr: "ignore",
    env: providerProcessEnvironment(environment),
    passEnv: Object.keys(environment),
  });
  const stdout = child.proc.stdout;
  if (!stdout || typeof stdout === "number") {
    child.kill();
    throw new Error("The agent model discovery stream is unavailable.");
  }
  const reader = stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async () => {
      const decoder = new TextDecoder();
      let text = "";
      let bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        text += decoder.decode(chunk.value, { stream: true });
        if (bytes > 1024 * 1024)
          throw new Error("The agent model catalog exceeded its size limit.");
      }
      if ((await child.proc.exited) !== 0)
        throw new Error("The agent could not list its models. Check its login and configuration.");
      const models = new Map<string, AgentModel>();
      for (const line of (text + decoder.decode()).split("\n").slice(0, 500)) {
        const parsed = ChatModelSchema.safeParse(line.trim());
        if (parsed.success && parsed.data.includes("/"))
          models.set(parsed.data, { id: parsed.data, label: parsed.data });
      }
      return [...models.values()];
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

export function readAgentModelCatalog(
  agent: string,
  host: ExecHost,
  command: string[],
  cwd: string,
  environment: Record<string, string> = {},
): Promise<AgentModel[]> {
  return readAgentCatalog("models", agent, host, command, cwd, environment);
}

export function readAgentCatalog(
  kind: "models",
  ...args: Parameters<typeof readAgentModelCatalog>
): Promise<AgentModel[]>;
export function readAgentCatalog(
  kind: "commands",
  ...args: Parameters<typeof readAgentModelCatalog>
): Promise<ChatAgentCommand[]>;
export async function readAgentCatalog(
  kind: "models" | "commands",
  agent: string,
  host: ExecHost,
  command: string[],
  cwd: string,
  environment: Record<string, string> = {},
): Promise<AgentModel[] | ChatAgentCommand[]> {
  const child = await hostSpawn(host, command, {
    cwd,
    stdin: "pipe",
    stderr: "ignore",
    env: providerProcessEnvironment(environment),
    passEnv: Object.keys(environment),
  });
  const send = (value: unknown) =>
    writeToStdin(child.proc.stdin, new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  const stdout = child.proc.stdout;
  if (!stdout || typeof stdout === "number") {
    child.kill();
    throw new Error(`The agent ${kind} discovery stream is unavailable.`);
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
        if (chunk.done) throw new Error(`The agent closed before returning its ${kind}.`);
        bytes += chunk.value.byteLength;
        if (bytes > 1024 * 1024)
          throw new Error(`The agent ${kind} catalog exceeded its size limit.`);
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
              throw new Error(`The agent could not list its ${kind}.`);
            const catalog = object(response.response);
            return kind === "models"
              ? parseAgentModels(catalog?.models, agent)
              : parseAgentCommands(catalog?.commands, agent);
          }
          if (message.id !== 1 && message.id !== requestId) continue;
          if (message.error) throw new Error(`The agent could not list its ${kind}.`);
          if (message.id === 1) {
            send({ method: "initialized", params: {} });
            send(
              kind === "models"
                ? {
                    id: requestId,
                    method: "model/list",
                    params: { limit: 100, includeHidden: false },
                  }
                : { id: requestId, method: "skills/list", params: { cwds: [cwd] } },
            );
          } else if (kind === "commands") {
            const entries = object(message.result)?.data;
            return parseAgentCommands(
              Array.isArray(entries)
                ? entries.flatMap((entry) => object(entry)?.skills ?? [])
                : null,
              agent,
            );
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
        timer = setTimeout(() => reject(new Error(`Agent ${kind} discovery timed out.`)), 15_000);
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
