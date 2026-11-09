import { ChatModelSchema } from "@orc/core/chat";
import { agentLabel } from "@orc/core/coding-agents";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { api } from "@/api/client";
import { AgentIcon } from "@/components/AgentIcon";
import {
  chipHeading,
  chipOption,
  composerChip,
  focusChipOption,
  onChipListKeyDown,
} from "@/components/ComposerChip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAgentCapabilities } from "@/hooks/useAgentCapabilities";
import { useEnabledAgents, useProviders } from "@/hooks/useAgents";
import { useChat } from "@/hooks/useChat";
import { useSsh } from "@/hooks/useSsh";
import { agentEffort, agentModelLabel } from "@/lib/composer-chips";
import { cn } from "@/lib/utils";

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
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [model, setModel] = useState("");
  const [error, setError] = useState("");
  const agentList = useRef<HTMLDivElement>(null);
  const modelList = useRef<HTMLDivElement>(null);
  const catalog = useQuery({
    queryKey: [
      "chat-models",
      config.agent,
      config.providerId,
      thread?.id,
      thread ? thread.host : ssh?.host,
    ],
    queryFn: () => api.chat.models(config.agent, thread?.id, config.providerId),
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

  const reset = () => {
    setCustom(false);
    setError("");
  };
  const chooseAgent = (agent: string) => {
    if (agent === config.agent) {
      focusChipOption(modelList.current);
      return;
    }
    reset();
    if (started) {
      chat.startAgentConversation(agent);
      setOpen(false);
    } else setConfig({ ...config, agent, providerId: undefined, model: "" });
  };
  const chooseProvider = (providerId: string) => {
    const profile = providers.find((item) => item.id === providerId);
    if (!profile) return;
    if (profile.id === (config.providerId ?? config.agent)) {
      focusChipOption(modelList.current);
      return;
    }
    reset();
    if (started) {
      chat.startAgentConversation(profile.agent, profile.id, profile.model, profile.options);
      setOpen(false);
    } else {
      const agentOptions: typeof config.agentOptions = {};
      if (profile.options) agentOptions[profile.agent] = profile.options;
      setConfig({
        ...config,
        agent: profile.agent,
        providerId: profile.id,
        model: profile.model,
        agentOptions,
      });
    }
  };
  const chooseModel = (next: string) => {
    setConfig({ ...config, model: next });
    setOpen(false);
  };
  const columns = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === "ArrowRight" && agentList.current?.contains(event.target as Node)) {
      event.preventDefault();
      focusChipOption(modelList.current);
    } else if (event.key === "ArrowLeft" && modelList.current?.contains(event.target as Node)) {
      event.preventDefault();
      focusChipOption(agentList.current);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="chat-agent-model-button"
          aria-label={`Agent and model: ${name}, ${modelName}${effort ? `, ${effort} effort` : ""}`}
          title={`${name} · ${summary}`}
          disabled={!ready}
          className={cn(composerChip, "max-w-64 text-on-surface")}
        >
          <AgentIcon agent={config.agent} decorative size={14} />
          <span
            data-chip-label
            data-testid="chat-agent-current"
            className="min-w-0 max-w-32 truncate"
          >
            {name}
          </span>
          <span data-chip-label aria-hidden="true" className="text-muted-foreground">
            ·
          </span>
          <span data-chip-label data-testid="chat-model-current" className="min-w-0 truncate">
            {summary}
          </span>
          <ChevronDown
            data-chip-label
            size={12}
            aria-hidden="true"
            className="shrink-0 opacity-60"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-testid="chat-agent-model-picker"
        aria-label="Choose agent and model"
        side="top"
        align="start"
        className="w-[26rem] max-w-[calc(100vw-2rem)] p-1.5"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          focusChipOption(started ? modelList.current : agentList.current);
        }}
        onKeyDown={columns}
      >
        <div className="grid grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] gap-1.5 max-[420px]:grid-cols-1">
          <div
            ref={agentList}
            role="menu"
            aria-label="Agent"
            data-testid="chat-agent-select"
            onKeyDown={onChipListKeyDown}
            className="min-w-0 border-border max-[420px]:border-b max-[420px]:pb-1.5 min-[421px]:border-r min-[421px]:pr-1.5"
          >
            <p className={chipHeading}>Agent</p>
            {providers.length > 0
              ? providers.map((profile) => (
                  <button
                    type="button"
                    key={profile.id}
                    role="menuitemradio"
                    data-chip-option
                    aria-checked={profile.id === (config.providerId ?? config.agent)}
                    data-testid={
                      profile.id === profile.agent
                        ? `chat-agent-option-${profile.agent}`
                        : `chat-provider-option-${profile.id}`
                    }
                    disabled={!ready}
                    onClick={() => chooseProvider(profile.id)}
                    className={chipOption}
                  >
                    <AgentIcon agent={profile.agent} decorative size={14} />
                    <span className="min-w-0 flex-1 truncate">{profile.name}</span>
                    {profile.id === (config.providerId ?? config.agent) && (
                      <Check size={14} aria-hidden="true" />
                    )}
                  </button>
                ))
              : agents.map((agent) => (
                  <button
                    type="button"
                    key={agent}
                    role="menuitemradio"
                    data-chip-option
                    aria-checked={agent === config.agent}
                    data-testid={`chat-agent-option-${agent}`}
                    disabled={!ready}
                    onClick={() => chooseAgent(agent)}
                    className={chipOption}
                  >
                    <AgentIcon agent={agent} decorative size={14} />
                    <span className="min-w-0 flex-1 truncate">{agentLabel(agent)}</span>
                    {agent === config.agent && <Check size={14} aria-hidden="true" />}
                  </button>
                ))}
          </div>
          <div
            ref={modelList}
            role="menu"
            aria-label={`${name} model`}
            data-testid="chat-model-select"
            onKeyDown={onChipListKeyDown}
            className="min-w-0"
          >
            <p className={chipHeading}>Model</p>
            <div className="max-h-64 overflow-y-auto">
              {[["", "Agent default"] as const, ...choices].map(([id, label]) => (
                <button
                  type="button"
                  key={id || "default"}
                  role="menuitemradio"
                  data-chip-option
                  aria-checked={config.model === id}
                  data-testid={id ? `chat-model-option-${id}` : "chat-model-option-default"}
                  disabled={modelsDisabled}
                  onClick={() => chooseModel(id)}
                  className={chipOption}
                >
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {config.model === id && <Check size={14} aria-hidden="true" />}
                </button>
              ))}
            </div>
            {custom ? (
              <form
                className="flex min-w-0 gap-1 px-1 py-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const parsed = ChatModelSchema.safeParse(model);
                  if (!parsed.success) {
                    setError("Enter a valid model ID (up to 200 characters).");
                    return;
                  }
                  chooseModel(parsed.data);
                }}
              >
                <Input
                  data-testid="chat-custom-model"
                  aria-label="Custom model ID"
                  autoFocus
                  value={model}
                  disabled={streaming}
                  onChange={(event) => setModel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    reset();
                  }}
                  className="min-w-0"
                />
                <Button
                  type="submit"
                  data-testid="chat-custom-model-apply"
                  disabled={streaming}
                  className="min-h-8 px-2"
                >
                  Use
                </Button>
              </form>
            ) : (
              <button
                type="button"
                data-chip-option
                data-testid="chat-model-option-custom"
                disabled={modelsDisabled}
                onClick={() => {
                  setModel(config.model);
                  setError("");
                  setCustom(true);
                }}
                className={cn(chipOption, "text-on-surface-variant")}
              >
                Custom model…
              </button>
            )}
            {error && (
              <p role="alert" className="px-2 py-1 text-xs text-error wrap-break-word">
                {error}
              </p>
            )}
            {catalog.isFetching && (
              <p className="px-2 py-1 text-xs text-muted-foreground">Loading models…</p>
            )}
            {warning && (
              <p
                data-testid="chat-model-warning"
                role="status"
                className="px-2 py-1 text-xs text-muted-foreground wrap-break-word"
              >
                {warning}
              </p>
            )}
          </div>
        </div>
        {(started || effort || fixedModel) && (
          <p
            data-testid="chat-agent-model-note"
            className="mt-1.5 border-t border-border px-2 pt-1.5 pb-0.5 text-xs text-muted-foreground"
          >
            {fixedModel
              ? `${name} picks its own model here.${thread ? " Changing agent starts a new session." : ""}`
              : streaming
                ? "Model changes are available after the current response. Changing agent starts a new session."
                : thread
                  ? "Changing agent starts a new session; this one stays in history. Model changes apply to the next turn."
                  : `Effort is set in ${name} options.`}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
