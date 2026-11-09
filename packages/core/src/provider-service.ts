import { createHash } from "node:crypto";
import { join } from "node:path";
import { ChatSettingsSchema } from "./chat.js";
import { agentLabel, CODING_AGENTS, enabledAgents } from "./coding-agents.js";
import { loadConfig, type OrcConfig, updateGlobalConfig } from "./config.js";
import { ConflictError, ValidationError } from "./errors.js";
import { userHome } from "./home.js";
import { resolveJobEnvironment } from "./job-environment.js";
import {
  type ProviderSettings,
  ProviderSettingsSchema,
  type StoredProviderProfile,
  StoredProvidersSchema,
} from "./providers.js";
import { encryptSecret } from "./secrets.js";

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
  return {
    env: resolved.env,
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
): ReturnType<typeof ChatSettingsSchema.parse> {
  const config = loadConfig();
  const base = ChatSettingsSchema.parse(config.preferences.chat ?? {});
  const saved = profiles(config);
  const id = providerId ?? (agent ? undefined : saved.default_id);
  const selectedAgent =
    agent ?? saved.instances.find((profile) => profile.id === id)?.agent ?? base.agent;
  const profile = providerForAgent(selectedAgent, id);
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
    if (!first) throw new ValidationError("Keep at least one enabled default provider.");
    saved.default_id = first.id;
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
