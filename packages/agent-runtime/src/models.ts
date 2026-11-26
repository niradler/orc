import { type ChatAgentCommand, ChatModelSchema } from "@orc/core/chat";
import { supportsModelDiscovery } from "@orc/core/coding-agents";
import { type ExecHost, hostBinary, hostExec, hostSpawn } from "@orc/core/exec-host";
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
  description?: string;
  efforts?: string[];
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

function printable(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return Array.from(value)
    .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
    .join("")
    .slice(0, max);
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)*/g) ?? [];
}

export function informativeDescription(description: string, label: string, agent: string): string {
  const known = new Set([...words(label), ...words(agent), "model"]);
  const found = words(description);
  return !found.length || found.some((word) => !known.has(word)) ? description : "";
}

export function isCustomAnthropicEndpoint(env?: Record<string, string | undefined>): boolean {
  const raw = env?.ANTHROPIC_BASE_URL?.trim();
  if (!raw) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host !== "api.anthropic.com" && !host.endsWith(".anthropic.com");
  } catch {
    return true;
  }
}

export function configuredClaudeEnvModel(
  env?: Record<string, string | undefined>,
): string | undefined {
  const raw = env?.ANTHROPIC_MODEL?.trim();
  if (!raw) return undefined;
  const parsed = ChatModelSchema.safeParse(raw);
  return parsed.success && parsed.data ? parsed.data : undefined;
}

function claudeEnvTierOverrides(env?: Record<string, string | undefined>): Record<string, string> {
  const map: Record<string, string> = {};
  const pairs: [string, string | undefined][] = [
    ["opus", env?.ANTHROPIC_DEFAULT_OPUS_MODEL],
    ["sonnet", env?.ANTHROPIC_DEFAULT_SONNET_MODEL],
    ["haiku", env?.ANTHROPIC_DEFAULT_HAIKU_MODEL],
  ];
  for (const [tier, raw] of pairs) {
    const trimmed = raw?.trim();
    if (!trimmed) continue;
    const parsed = ChatModelSchema.safeParse(trimmed);
    if (parsed.success && parsed.data) map[tier] = parsed.data;
  }
  return map;
}

export function parseAgentModels(
  value: unknown,
  agent: string,
  env?: Record<string, string | undefined>,
): AgentModel[] {
  if (!Array.isArray(value)) throw new Error("The agent returned no model catalog.");
  const customAnthropic = agent === "claude" && isCustomAnthropicEndpoint(env);
  const envClaudeModel = agent === "claude" ? configuredClaudeEnvModel(env) : undefined;
  const tierOverrides = agent === "claude" ? claudeEnvTierOverrides(env) : {};
  const models = new Map<string, AgentModel>();

  if (agent === "claude" && envClaudeModel) {
    models.set(envClaudeModel, {
      id: envClaudeModel,
      label: envClaudeModel,
      description: customAnthropic
        ? "Configured via ANTHROPIC_MODEL for custom endpoint"
        : "Configured via ANTHROPIC_MODEL",
    });
  }
  for (const overrideModel of Object.values(tierOverrides)) {
    if (!models.has(overrideModel)) {
      models.set(overrideModel, {
        id: overrideModel,
        label: overrideModel,
        description: customAnthropic
          ? "Configured custom endpoint model"
          : "Configured in environment",
      });
    }
  }

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
    const id = parsed.data;
    if (agent === "claude" && customAnthropic) {
      if (id === "default") {
        models.set(id, {
          id,
          label: envClaudeModel ? `Default (${envClaudeModel})` : "Default",
          description: envClaudeModel
            ? `Uses ${envClaudeModel} on custom endpoint`
            : "Custom endpoint default",
        });
        continue;
      }
      const lower = id.toLowerCase();
      const matchedTier = (["opus", "sonnet", "haiku"] as const).find(
        (tier) => lower === tier || lower.startsWith(`${tier}[`),
      );
      if (matchedTier) {
        const mapped = tierOverrides[matchedTier];
        if (mapped) {
          models.set(id, {
            id,
            label: `${mapped} (${id})`,
            description: "Mapped via environment on custom endpoint",
          });
        }
        continue;
      }
    }
    if (agent === "claude" && !customAnthropic && id === "default" && envClaudeModel) {
      models.set(id, {
        id,
        label: `Default (${envClaudeModel})`,
        description: "Configured via ANTHROPIC_MODEL",
      });
      continue;
    }
    const label = printable(row.displayName ?? row.name, 120) || id;
    const description = informativeDescription(printable(row.description, 300), label, agent);
    const efforts = (
      Array.isArray(row.supportedEffortLevels)
        ? row.supportedEffortLevels
        : Array.isArray(row.supportedReasoningEfforts)
          ? row.supportedReasoningEfforts.map((effort) => object(effort)?.reasoningEffort)
          : []
    )
      .filter(
        (effort): effort is string =>
          typeof effort === "string" && /^[a-z][a-z0-9_-]{0,63}$/i.test(effort),
      )
      .slice(0, 16);
    models.set(id, {
      id,
      label,
      ...(description ? { description } : {}),
      ...(efforts.length ? { efforts } : {}),
    });
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
  if (agent !== "claude" && agent !== "codex" && agent !== "opencode") return [];
  const profile = providerForAgent(agent, providerId, true);
  const command = await agentCommand(agent, host, profile);
  const environment = resolveProviderEnvironment(profile).env;
  if (agent === "opencode") return readOpenCodeCommands(host, command, cwd, environment);
  return readAgentCatalog(
    "commands",
    agent,
    host,
    [...command, ...agentProtocolArgs(agent)],
    cwd,
    environment,
  );
}

export async function readOpenCodeCommands(
  host: ExecHost,
  command: string[],
  cwd: string,
  environment: Record<string, string> = {},
): Promise<ChatAgentCommand[]> {
  const password = crypto.randomUUID();
  const env = { ...environment, OPENCODE_SERVER_PASSWORD: password };
  const child = await hostSpawn(
    host,
    [...command, "serve", "--port", "0", "--hostname", "127.0.0.1"],
    {
      cwd,
      stdin: "ignore",
      stderr: "ignore",
      env: providerProcessEnvironment(env),
      passEnv: Object.keys(env),
    },
  );
  const stdout = child.proc.stdout;
  if (!stdout || typeof stdout === "number") {
    child.kill();
    throw new Error("The agent commands discovery stream is unavailable.");
  }
  const reader = stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async () => {
      const decoder = new TextDecoder();
      let text = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("The agent closed before returning its commands.");
        text += decoder.decode(chunk.value, { stream: true });
        if (text.length > 64 * 1024) throw new Error("The agent did not start its server.");
        const url = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(text)?.[1];
        if (!url) continue;
        const result = await hostExec(host, ["curl", "-sfS", "-K", "-"], {
          input: `user = "opencode:${password}"\nurl = "${url}/command?directory=${encodeURIComponent(cwd)}"\n`,
          timeoutMs: 10_000,
          login: false,
        });
        if (result.code !== 0) throw new Error("The agent could not list its commands.");
        return parseAgentCommands(JSON.parse(result.stdout), "opencode");
      }
    };
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Agent commands discovery timed out.")), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    child.kill();
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
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
    } else if (agent === "opencode") {
      source = printable(row.source, 120) || agent;
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
      argumentHint:
        printable(row.argumentHint, 500) ||
        (Array.isArray(row.hints) ? printable(row.hints.join(" "), 500) : ""),
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
  const effectiveEnv = providerProcessEnvironment(environment);
  const child = await hostSpawn(host, command, {
    cwd,
    stdin: "pipe",
    stderr: "ignore",
    env: effectiveEnv,
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
              ? parseAgentModels(catalog?.models, agent, effectiveEnv)
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
