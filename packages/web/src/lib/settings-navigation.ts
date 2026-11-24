export const SETTINGS_GROUP_IDS = [
  "general",
  "servers",
  "hosts",
  "agents",
  "connections",
  "knowledge",
  "secrets",
  "notifications",
  "usage",
  "security",
  "about",
] as const;

export type SettingsGroupId = (typeof SETTINGS_GROUP_IDS)[number];

export const SETTINGS_DOMAINS = [
  { id: "workspace", label: "Workspace" },
  { id: "activity", label: "Activity" },
  { id: "system", label: "System" },
] as const;

export type SettingsDomainId = (typeof SETTINGS_DOMAINS)[number]["id"];

export type SettingsGroup = {
  id: SettingsGroupId;
  label: string;
  description: string;
  domain: SettingsDomainId;
};

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    id: "general",
    label: "General",
    description: "Appearance, terminal font, voice and browser",
    domain: "workspace",
  },
  {
    id: "servers",
    label: "Servers",
    description: "ORC servers this app opens",
    domain: "workspace",
  },
  {
    id: "hosts",
    label: "Hosts",
    description: "Where agents run",
    domain: "workspace",
  },
  {
    id: "agents",
    label: "Agents",
    description: "Providers, chat defaults and MCP setup",
    domain: "workspace",
  },
  {
    id: "connections",
    label: "Connections",
    description: "Channels, APIs and MCP servers",
    domain: "workspace",
  },
  {
    id: "knowledge",
    label: "Knowledge",
    description: "Parsing, embeddings and retrieval defaults",
    domain: "workspace",
  },
  {
    id: "secrets",
    label: "Secrets",
    description: "Encrypted project secrets and references",
    domain: "workspace",
  },
  {
    id: "notifications",
    label: "Notifications",
    description: "Alerts, approvals and cleanup periods",
    domain: "activity",
  },
  {
    id: "usage",
    label: "Usage",
    description: "Tokens and cost by project and model",
    domain: "activity",
  },
  {
    id: "security",
    label: "Security",
    description: "Sign-in, session lifetime and API tokens",
    domain: "system",
  },
  {
    id: "about",
    label: "About",
    description: "Versions, updates, restart and data locations",
    domain: "system",
  },
];

export const AGENT_TABS = ["providers", "chat", "mcp"] as const;
export type AgentTab = (typeof AGENT_TABS)[number];

export const CONNECTION_TABS = ["channels", "integrations"] as const;
export type ConnectionTab = (typeof CONNECTION_TABS)[number];

type SettingsTarget = {
  group: SettingsGroupId;
  agentTab?: AgentTab;
  connectionTab?: ConnectionTab;
};

/** Older `?settingsSection=` links and deep links keep landing on the right panel. */
const SETTINGS_TARGETS: Record<string, SettingsTarget> = {
  general: { group: "general" },
  connection: { group: "servers" },
  servers: { group: "servers" },
  hosts: { group: "hosts" },
  execution: { group: "hosts" },
  appearance: { group: "general" },
  terminals: { group: "general" },
  voice: { group: "general" },
  browser: { group: "general" },
  agents: { group: "agents" },
  chat: { group: "agents", agentTab: "chat" },
  mcp: { group: "agents", agentTab: "mcp" },
  channels: { group: "connections", connectionTab: "channels" },
  integrations: { group: "connections", connectionTab: "integrations" },
  knowledge: { group: "knowledge" },
  secrets: { group: "secrets" },
  notifications: { group: "notifications" },
  attention: { group: "notifications" },
  usage: { group: "usage" },
  security: { group: "security" },
  about: { group: "about" },
  server: { group: "about" },
  storage: { group: "about" },
};

const GROUP_ID_SET = new Set<string>(SETTINGS_GROUP_IDS);

export function resolveSettingsTarget(section: string | null): SettingsTarget | undefined {
  if (!section) return undefined;
  if (GROUP_ID_SET.has(section)) return { group: section as SettingsGroupId };
  return SETTINGS_TARGETS[section];
}

export function settingsGroupsFor(domain: SettingsDomainId): SettingsGroup[] {
  return SETTINGS_GROUPS.filter((group) => group.domain === domain);
}
