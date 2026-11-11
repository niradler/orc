import { createHash } from "node:crypto";
import { join } from "node:path";
import { ChatSettingsSchema } from "./chat.js";
import {
  agentLabel,
  CODING_AGENTS,
  DEFAULT_ENABLED_AGENTS,
  enabledAgents,
} from "./coding-agents.js";
import { loadConfig, localAgentBinary, type OrcConfig, updateGlobalConfig } from "./config.js";
import { ConflictError, ValidationError } from "./errors.js";
import { userHome } from "./home.js";
import { resolveJobEnvironment } from "./job-environment.js";
import {
  type ProviderSettings,
  ProviderSettingsSchema,
  type StoredProviderProfile,
  StoredProvidersSchema,
} from "./providers.js";
import { decryptSecret, encryptSecret } from "./secrets.js";

/** Persist discovery once; a later missing installation must not erase user intent. */
export function initializeAgentPreferences(
  findBinary: (name: string) => string | null = localAgentBinary,
): void {
  const config = loadConfig();
  if (config.providers || config.preferences.agents !== undefined) return;
  const agents = DEFAULT_ENABLED_AGENTS.filter((id) => {
    const command = config.agent_loop.acp_commands?.[id]?.command;
    if (command) return !!findBinary(command);
    return CODING_AGENTS.find((agent) => agent.id === id)?.binaries.some(
      (binary) => !!findBinary(binary),
    );
  });
  updateGlobalConfig((raw) => {
    const preferences = (raw.preferences ?? {}) as Record<string, unknown>;
    const chat = ChatSettingsSchema.parse(config.preferences.chat ?? {});
    raw.preferences = {
      ...preferences,
      agents,
      ...(agents.length && !agents.some((id) => id === chat.agent)
        ? { chat: { ...chat, agent: agents[0], providerId: undefined, model: "" } }
        : {}),
    };
  });
}

function profiles(config: OrcConfig): { instances: StoredProviderProfile[]; default_id: string } {
  if (config.providers) return config.providers;
  const chat = ChatSettingsSchema.parse(config.preferences.chat ?? {});
  const enabled = enabledAgents(config.preferences.agents);
  const ids = [...new Set([...CODING_AGENTS.map((agent) => agent.id), ...enabled])];
  return {
    instances: ids.map((agent) => ({
      id: agent,
      name: agentLabel(agent),
      agent,
      enabled: enabled.includes(agent),
      executable:
        agent === "claude" || agent === "codex"
          ? (config.preferences.provider_paths?.[agent] ?? "")
          : "",
      home: "",
      model: chat.agent === agent ? chat.model : "",
      options: chat.agentOptions[agent],
      environment: [],
    })),
    default_id: enabled.includes(chat.agent) ? chat.agent : (enabled[0] ?? "codex"),
  };
}
export function providerRevision(config = loadConfig()): string {
  return createHash("sha256")
    .update(JSON.stringify(profiles(config)))
    .digest("hex");
}
export function readProviderSettings(config = loadConfig()): ProviderSettings {
  const saved = profiles(config);
  return {
    providers: saved.instances.map((profile) => ({
      ...profile,
      environment: profile.environment.map((row) => ({
        ...row,
        value: row.secret ? null : row.value,
      })),
    })),
    default_provider_id: saved.default_id,
    revision: providerRevision(config),
  };
}
/** Stored profiles with encrypted secret values intact; for server-side readers only. */
export function storedProviderProfiles(config = loadConfig()): StoredProviderProfile[] {
  return profiles(config).instances;
}
export function saveProviderSettings(input: ProviderSettings): ProviderSettings {
  const next = ProviderSettingsSchema.parse(input);
  const config = loadConfig();
  if (next.revision !== providerRevision(config))
    throw new ConflictError(
      "Provider settings changed on the server. Reload before saving; keep your draft for comparison.",
    );
  const previous = profiles(config);
  const instances = next.providers.map((profile): StoredProviderProfile => {
    const old = previous.instances.find((item) => item.id === profile.id);
    if (old && old.agent !== profile.agent)
      throw new ValidationError(
        "Create a new provider to change its adapter; existing sessions keep their adapter.",
      );
    return {
      ...profile,
      environment: profile.environment.map((row) => {
        if (row.value === null) {
          const saved = old?.environment.find((item) => item.name === row.name && item.secret);
          if (!saved || !row.secret)
            throw new ValidationError("Re-enter a secret when creating or renaming its variable.");
          return saved;
        }
        return { ...row, value: row.secret ? encryptSecret(row.value) : row.value };
      }),
    };
  });
  const selected = instances.find((profile) => profile.id === next.default_provider_id);
  if (!selected) throw new ValidationError("Choose a default provider");
  const updated = updateGlobalConfig((raw) => {
    raw.providers = StoredProvidersSchema.parse({ instances, default_id: selected.id });
    const preferences = (raw.preferences as Record<string, unknown> | undefined) ?? {};
    const chat = ChatSettingsSchema.parse(preferences.chat ?? {});
    const paths = { ...(preferences.provider_paths as Record<string, string> | undefined) };
    for (const profile of instances)
      if (profile.id === profile.agent && (profile.agent === "claude" || profile.agent === "codex"))
        paths[profile.agent] = profile.executable;
    raw.preferences = {
      ...preferences,
      agents: [
        ...new Set(instances.filter((profile) => profile.enabled).map((profile) => profile.agent)),
      ],
      provider_paths: paths,
      chat: { ...chat, agent: selected.agent, providerId: selected.id, model: selected.model },
    };
  });
  return readProviderSettings(updated);
}
export function providerForAgent(
  agent: string,
  providerId?: string,
  allowDisabled = false,
): StoredProviderProfile | undefined {
  const saved = profiles(loadConfig());
  const selected = providerId
    ? saved.instances.find((profile) => profile.id === providerId)
    : (saved.instances.find(
        (profile) => profile.id === saved.default_id && profile.agent === agent,
      ) ?? saved.instances.find((profile) => profile.id === agent));
  if (providerId && !selected && allowDisabled && providerId === agent) return undefined;
  if (providerId && !selected)
    throw new ValidationError(
      "This provider is no longer configured. Choose another provider for a new session.",
    );
  if (selected && selected.agent !== agent)
    throw new ValidationError("The provider does not match the coding-agent adapter.");
  if (selected && !selected.enabled && !allowDisabled)
    throw new ValidationError("Enable this provider before starting a new session.");
  return selected;
}
export function resolveProviderEnvironment(profile: StoredProviderProfile | undefined): {
  env: Record<string, string>;
  redact: (text: string) => string;
  stream: () => { push: (text: string) => string; flush: () => string };
} {
  const resolved = resolveJobEnvironment(profile?.environment ?? []);
  const variable = profile ? agentHomeVariable(profile.agent) : undefined;
  const env = { ...resolved.env };
  // A profile's own home is the generic way to isolate one CLI login; an explicit
  // environment row still wins, including an empty value that clears it.
  const explicit =
    !!variable && !!profile?.environment.some((row) => row.name === variable && row.value !== null);
  if (variable && profile?.home && !explicit)
    env[variable] = expandAgentHome(profile.home) ?? profile.home;
  if (variable && env[variable]?.startsWith("~"))
    env[variable] = expandAgentHome(env[variable]) ?? env[variable];
  return {
    env,
    redact: resolved.redact,
    stream: () => {
      const stream = resolved.createRedactor();
      return { push: stream.write, flush: stream.finish };
    },
  };
}
export function providerExecutable(profile: StoredProviderProfile | undefined): string | undefined {
  const value = profile?.executable;
  if (!value) return undefined;
  return value.startsWith("~/") || value.startsWith("~\\")
    ? join(userHome(), value.slice(2))
    : value;
}
export function agentHomeVariable(agent: string): string | undefined {
  if (agent === "claude") return "CLAUDE_CONFIG_DIR";
  if (agent === "codex") return "CODEX_HOME";
  return undefined;
}
export function expandAgentHome(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith("~/") || value.startsWith("~\\")
    ? join(userHome(), value.slice(2))
    : value;
}
export function agentDefaultHome(agent: string): string | undefined {
  const variable = agentHomeVariable(agent);
  if (!variable) return undefined;
  return expandAgentHome(
    process.env[variable] || join(userHome(), agent === "claude" ? ".claude" : ".codex"),
  );
}
/**
 * The home a profile explicitly configures, before falling back to the host default.
 * Mirrors resolveProviderEnvironment: an explicit environment row wins over the home
 * field (an empty value clears the override), so identity, quotas and session scans
 * read the same directory the spawned CLI uses.
 */
export function providerConfiguredHome(profile: {
  agent: string;
  home?: string | undefined;
  environment: { name: string; value: string | null; secret: boolean }[];
}): string | undefined {
  const variable = agentHomeVariable(profile.agent);
  if (!variable) return undefined;
  const row = profile.environment.find((item) => item.name === variable && item.value !== null);
  if (row) {
    let value = row.value ?? "";
    if (row.secret) {
      try {
        value = decryptSecret(value);
      } catch {
        return undefined;
      }
    }
    return value ? expandAgentHome(value) : undefined;
  }
  return profile.home ? expandAgentHome(profile.home) : undefined;
}
export function providerEffectiveHome(profile: {
  agent: string;
  home?: string | undefined;
  environment: { name: string; value: string | null; secret: boolean }[];
}): string | undefined {
  return providerConfiguredHome(profile) ?? agentDefaultHome(profile.agent);
}
/** Every home that can hold this agent's native state on the local host, default first. */
export function agentHomes(agent: string): string[] {
  const homes = profiles(loadConfig())
    .instances.filter((profile) => profile.agent === agent)
    .map(providerEffectiveHome);
  return [...new Set([agentDefaultHome(agent), ...homes].filter((home): home is string => !!home))];
}

export function providerProcessEnvironment(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ...overrides,
  };
}
export function providerChatDefaults(
  providerId?: string,
  agent?: string,
  allowDisabled = false,
): ReturnType<typeof ChatSettingsSchema.parse> {
  const config = loadConfig();
  const base = ChatSettingsSchema.parse(config.preferences.chat ?? {});
  const saved = profiles(config);
  const id = providerId ?? (agent ? undefined : saved.default_id);
  const selectedAgent =
    agent ?? saved.instances.find((profile) => profile.id === id)?.agent ?? base.agent;
  const profile = providerForAgent(
    selectedAgent,
    id,
    allowDisabled || (!providerId && !agent && !saved.instances.some((item) => item.enabled)),
  );
  if (!profile) return { ...base, agent: selectedAgent };
  const agentOptions = config.providers ? {} : { ...base.agentOptions };
  delete agentOptions[profile.agent];
  return {
    ...base,
    agent: profile.agent,
    providerId: profile.id,
    model: profile.model,
    agentOptions: {
      ...agentOptions,
      ...(profile.options ? { [profile.agent]: profile.options } : {}),
    },
  };
}

export function applyProviderPreferencePatch(
  raw: Record<string, unknown>,
  patch: Partial<OrcConfig["preferences"]>,
): void {
  if (!raw.providers) return;
  const saved = StoredProvidersSchema.parse(raw.providers);
  if (patch.agents) {
    const enabled = enabledAgents(patch.agents);
    for (const agent of enabled)
      if (!saved.instances.some((profile) => profile.agent === agent))
        saved.instances.push({
          id: agent,
          name: agentLabel(agent),
          agent,
          enabled: true,
          executable: "",
          home: "",
          model: "",
          environment: [],
        });
    for (const profile of saved.instances) profile.enabled = enabled.includes(profile.agent);
  }
  if (patch.provider_paths)
    for (const profile of saved.instances)
      if (profile.id === profile.agent && (profile.agent === "claude" || profile.agent === "codex"))
        profile.executable = patch.provider_paths[profile.agent] ?? "";
  if (patch.chat) {
    const id = patch.chat.providerId ?? patch.chat.agent;
    const profile = saved.instances.find((item) => item.id === id);
    if (!profile || profile.agent !== patch.chat.agent)
      throw new ValidationError("Choose a configured provider that matches the chat adapter.");
    saved.default_id = profile.id;
    profile.model = patch.chat.model;
    if (!patch.chat.providerId) profile.options = patch.chat.agentOptions[profile.agent];
  }
  if (!saved.instances.some((profile) => profile.id === saved.default_id && profile.enabled)) {
    const first = saved.instances.find((profile) => profile.enabled);
    if (first) saved.default_id = first.id;
  }
  raw.providers = StoredProvidersSchema.parse(saved);
  const selected = saved.instances.find((profile) => profile.id === saved.default_id);
  if (selected) {
    const preferences = (raw.preferences ?? {}) as Record<string, unknown>;
    const chat = ChatSettingsSchema.parse(preferences.chat ?? {});
    raw.preferences = {
      ...preferences,
      chat: { ...chat, agent: selected.agent, providerId: selected.id, model: selected.model },
    };
  }
}
