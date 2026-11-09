import { agentLabel } from "@orc/core/coding-agents";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { AgentModelPicker } from "@/components/AgentModelPicker";
import { useAgentCapabilities } from "@/hooks/useAgentCapabilities";
import { useEnabledAgents } from "@/hooks/useAgents";
import { useChat } from "@/hooks/useChat";
import { useSsh } from "@/hooks/useSsh";
import { agentEffort, agentModelLabel } from "@/lib/composer-chips";

export function ChatAgentModelPicker() {
  const chat = useChat();
  const { config, setConfig, streaming, thread, ready } = chat;
  const { data: ssh } = useSsh();
  const agents = Array.from(new Set([...useEnabledAgents(), config.agent]));
  const catalog = useQuery({
    queryKey: ["chat-models", config.agent, thread?.id, thread ? thread.host : ssh?.host],
    queryFn: () => api.chat.models(config.agent, thread?.id),
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
  const name = agentLabel(config.agent);
  const summary = agentModelLabel(modelName, effort);
  const started = !!thread || streaming;
  const fixedModel = useAgentCapabilities(config.agent, thread)?.modelSelection === false;
  const modelsDisabled = streaming || !ready || fixedModel;

  const note = fixedModel
    ? `${name} picks its own model here.${thread ? " Changing agent starts a new session." : ""}`
    : streaming
      ? "Model changes are available after the current response. Changing agent starts a new session."
      : thread
        ? "Changing agent starts a new session; this one stays in history. Model changes apply to the next turn."
        : effort
          ? `Effort is set in ${name} options.`
          : undefined;
  return (
    <AgentModelPicker
      agent={config.agent}
      selectedModel={config.model}
      agents={agents}
      choices={choices}
      ready={ready}
      streaming={streaming}
      modelsDisabled={modelsDisabled}
      fetching={catalog.isFetching}
      warning={warning}
      summary={summary}
      note={note}
      started={started}
      onAgent={(agent) => {
        if (agent === config.agent) return false;
        if (started) {
          chat.startAgentConversation(agent);
          return true;
        }
        setConfig({ ...config, agent, model: "" });
        return false;
      }}
      onModel={(model) => setConfig({ ...config, model })}
    />
  );
}
