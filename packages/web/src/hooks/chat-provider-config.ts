import type { ChatSettings } from "@orc/core/chat";
import type { ChatAgentOptions } from "@orc/core/chat-options";
import type { ProviderProfile } from "@orc/core/providers";

export type ProviderDrafts = Record<string, { model: string; options?: ChatAgentOptions }>;

export function providerSelection(
  config: ChatSettings,
  drafts: ProviderDrafts | undefined,
  profile: ProviderProfile,
): { config: ChatSettings; providerDrafts: ProviderDrafts } {
  const providerDrafts = {
    ...drafts,
    [config.providerId ?? config.agent]: {
      model: config.model,
      options: config.agentOptions[config.agent],
    },
  };
  const remembered = Object.hasOwn(providerDrafts, profile.id)
    ? providerDrafts[profile.id]
    : undefined;
  const options = remembered ? remembered.options : profile.options;
  // Keep the transport's 20-agent limit; provider drafts retain edits independently.
  const agentOptions = Object.fromEntries(
    Object.entries(config.agentOptions)
      .filter(([agent]) => agent !== profile.agent)
      .slice(-19),
  );
  if (options) agentOptions[profile.agent] = options;
  return {
    config: {
      ...config,
      agent: profile.agent,
      providerId: profile.id,
      model: remembered?.model ?? profile.model,
      agentOptions,
    },
    providerDrafts: Object.fromEntries(Object.entries(providerDrafts).slice(-64)),
  };
}
