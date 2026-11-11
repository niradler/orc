import { agentLabel } from "@orc/core/coding-agents";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { AgentModelPicker } from "@/components/AgentModelPicker";
import { useAgentCapabilities } from "@/hooks/useAgentCapabilities";
import { useEnabledAgents, useProviders } from "@/hooks/useAgents";
import { useChat } from "@/hooks/useChat";
import { useSsh } from "@/hooks/useSsh";
import { agentEffort, agentModelLabel } from "@/lib/composer-chips";

export function ChatAgentModelPicker() {
  const chat = useChat();
  const { config, setConfig, streaming, thread, ready } = chat;
  const { data: ssh } = useSsh();
  const agents = Array.from(new Set([...useEnabledAgents(), config.agent]));
  const providerSettings = useProviders();
  const providers =
    providerSettings.data?.providers.filter(
      (profile) => profile.enabled || profile.id === config.providerId,
    ) ?? [];
  const selectedProvider = providers.find(
    (profile) => profile.id === (config.providerId ?? config.agent),
  );
  const catalog = useQuery({
    queryKey: [
      "chat-models",
      config.agent,
      config.providerId,
      thread?.id,
      thread ? thread.host : ssh?.host,
    ],
    queryFn: () =>
      api.chat.models(config.agent, thread?.id, undefined, undefined, config.providerId),
    enabled: ready,
    staleTime: 120_000,
    retry: false,
  });
  const choices = new Map((catalog.data?.models ?? []).map((entry) => [entry.id, entry.label]));
  for (const entry of config.models.filter((entry) => entry.agent === config.agent))
    if (!choices.has(entry.id)) choices.set(entry.id, entry.id);
  if (config.model && !choices.has(config.model)) choices.set(config.model, config.model);
  const warning = catalog.isError
    ? "Models could not be loaded. Saved and custom models are available."
    : catalog.data?.warning;
  const modelName = choices.get(config.model) || config.model || "Agent default";
  const effort = agentEffort(config);
  const name = selectedProvider?.name ?? agentLabel(config.agent);
  const summary = agentModelLabel(modelName, effort);
  const started = !!thread || streaming;
  const fixedModel = useAgentCapabilities(config.agent, thread)?.modelSelection === false;
  const modelsDisabled = streaming || !ready || fixedModel;

  const note = fixedModel
    ? `${name} picks its own model here.${thread ? " Changing agent starts a new session." : ""}`
    : streaming
      ? "Provider and model changes are available after the current response. Changing agent starts a new session."
      : thread
        ? "Switching to another account of the same agent continues this chat with your prior context. Changing agent starts a new session. Model changes apply to the next turn."
        : effort
          ? `Effort is set in ${name} options.`
          : undefined;
  return (
    <AgentModelPicker
      agent={config.agent}
      agentName={name}
      providers={providers}
      providerId={config.providerId}
      onProvider={(id) => {
        const profile = providers.find((item) => item.id === id);
        if (!profile || id === (config.providerId ?? config.agent)) return false;
        if (streaming) return false;
        if (thread && profile.agent === config.agent) {
          // Same adapter: keep this conversation and let the server rebuild the
          // native session on the next turn with the new account.
          chat.selectProvider(profile);
          return false;
        }
        if (started) {
          chat.startAgentConversation(profile.agent, id, profile.model, profile.options);
          return true;
        }
        chat.selectProvider(profile);
        return false;
      }}
      selectedModel={config.model}
      agents={agents}
      choices={choices}
      ready={ready}
      streaming={streaming}
      modelsDisabled={modelsDisabled}
      fetching={catalog.isFetching}
      warning={warning}
      summary={summary}
      accessibleSummary={`${modelName}${effort ? `, ${effort} effort` : ""}`}
      note={note}
      started={started}
      onAgent={(agent) => {
        if (agent === config.agent) return false;
        if (started) {
          chat.startAgentConversation(agent);
          return true;
        }
        setConfig({ ...config, agent, providerId: undefined, model: "" });
        return false;
      }}
      onModel={(model) => setConfig({ ...config, model })}
    />
  );
}
