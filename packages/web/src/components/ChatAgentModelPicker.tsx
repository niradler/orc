import type { ComposerProfile } from "@orc/core/chat";
import { agentLabel } from "@orc/core/coding-agents";
import { ulid } from "@orc/core/ids";
import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/api/client";
import { AgentModelPicker } from "@/components/AgentModelPicker";
import { chipHeading } from "@/components/ComposerChip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { providerSelection } from "@/hooks/chat-provider-config";
import { useAgentCapabilities } from "@/hooks/useAgentCapabilities";
import { useComposerPreferences, useEnabledAgents, useProviders } from "@/hooks/useAgents";
import { useChat } from "@/hooks/useChat";
import { useSsh } from "@/hooks/useSsh";
import {
  agentEffort,
  agentEffortChoices,
  agentEffortValue,
  agentModelLabel,
  effectivePermissionMode,
  liveEffortChoices,
  permissionModes,
  permissionText,
  withAgentEffort,
  withPermissionMode,
} from "@/lib/composer-chips";

const profileChip =
  "inline-flex min-h-8 items-center px-2 text-xs hover:bg-surface-highest focus-visible:outline-2 focus-visible:outline-focus max-sm:min-h-11 pointer-coarse:min-h-11";

export function ChatAgentModelPicker() {
  const chat = useChat();
  const { config, setConfig, streaming, thread, ready, workspace } = chat;
  const { data: ssh } = useSsh();
  // A new chat asks the server for models on the host it will actually run on.
  const host = workspace?.host === undefined ? (ssh?.host ?? null) : workspace.host;
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
      thread ? thread.host : host,
    ],
    queryFn: () =>
      api.chat.models(
        config.agent,
        thread?.id,
        thread ? undefined : host,
        undefined,
        config.providerId,
      ),
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
  const effortValue = agentEffortValue(config);
  const capabilities = useAgentCapabilities(config.agent, thread);
  // OpenCode's effort levels are model-dependent: the session reports them live,
  // and the model catalog probes them for a chat that has not started yet.
  const effortsFor = (model: string) => {
    if (config.agent === "opencode")
      return liveEffortChoices(capabilities?.effortChoices ?? catalog.data?.effortChoices);
    const models = catalog.data?.models ?? [];
    const entry = models.find((item) => item.id === model);
    return agentEffortChoices(
      config.agent,
      entry && (entry.efforts ?? (models.some((item) => item.efforts) ? [] : undefined)),
    );
  };
  const effortChoices = effortsFor(config.model);
  const staleEffort =
    config.agent !== "opencode" &&
    !!effortValue &&
    !!catalog.data?.models.some((item) => item.id === config.model) &&
    !effortChoices.some((choice) => choice.value === effortValue);
  const effort = staleEffort ? null : agentEffort(config);
  useEffect(() => {
    if (!staleEffort) return;
    const next = withAgentEffort(config, "");
    setConfig(next);
    const options = next.agentOptions[config.agent];
    if (thread && options) void chat.applyAgentOptions(config.agent, options).catch(() => {});
  }, [staleEffort, config, setConfig, thread, chat]);
  const name = selectedProvider?.name ?? agentLabel(config.agent);
  const summary = agentModelLabel(modelName, effort);
  const started = !!thread || streaming;
  const navigate = useNavigate();
  const preferences = useComposerPreferences();
  const favorites = new Set(
    preferences.favorites.filter((entry) => entry.agent === config.agent).map((entry) => entry.id),
  );
  const [naming, setNaming] = useState<string | null>(null);
  const modes = permissionModes(capabilities);
  function applyProfile(profile: ComposerProfile): void {
    const provider = providers.find((item) => item.id === profile.providerId);
    const providerId = provider?.id;
    const base = provider
      ? providerSelection(config, undefined, provider).config
      : { ...config, agent: profile.agent, providerId: undefined };
    let next = withAgentEffort({ ...base, model: profile.model }, profile.effort);
    if (profile.permissionMode) next = withPermissionMode(next, profile.permissionMode);
    const options = next.agentOptions[profile.agent];
    if (
      started &&
      (profile.agent !== config.agent ||
        (providerId ?? profile.agent) !== (config.providerId ?? config.agent))
    ) {
      chat.startAgentConversation(
        profile.agent,
        providerId,
        profile.model,
        options,
        profile.permissionMode,
      );
      return;
    }
    void chat.changePermissions(next);
    if (thread && options) void chat.applyAgentOptions(profile.agent, options).catch(() => {});
  }
  function saveProfile(name: string): void {
    const mode = effectivePermissionMode(config);
    const profile: ComposerProfile = {
      id: ulid(),
      name,
      agent: config.agent,
      ...(config.providerId ? { providerId: config.providerId } : {}),
      model: config.model,
      effort: effortValue,
      ...(modes.includes(mode) ? { permissionMode: mode } : {}),
    };
    preferences.save((current) => ({
      composer_profiles: [
        ...(current.composer_profiles ?? []).filter((item) => item.name !== name),
        profile,
      ].slice(-50),
    }));
    setNaming(null);
  }
  const fixedModel = capabilities?.modelSelection === false;
  const modelsDisabled = streaming || !ready || fixedModel;

  const note = fixedModel
    ? `${name} picks its own model here.${thread ? " Changing agent starts a new session." : ""}`
    : streaming
      ? "Provider, model and effort changes are available after the current response. Changing agent starts a new session."
      : thread
        ? "Switching to another account of the same agent continues this chat with your prior context. Changing agent starts a new session. Model and effort changes apply to the next turn."
        : config.agent === "opencode" && !effortChoices.length
          ? "Effort levels load from the agent when the session starts."
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
      favorites={favorites}
      onFavorite={(model) =>
        preferences.save((current) => {
          const saved = current.favorite_models ?? [];
          const pinned = saved.some((entry) => entry.agent === config.agent && entry.id === model);
          return {
            favorite_models: pinned
              ? saved.filter((entry) => entry.agent !== config.agent || entry.id !== model)
              : [...saved, { agent: config.agent, id: model }].slice(-100),
          };
        })
      }
      onProviderSettings={(id) =>
        navigate(
          `/settings?settingsSection=agents&agentsTab=providers&provider=${encodeURIComponent(id)}`,
        )
      }
      footer={(close) => (
        <div data-testid="chat-profiles" className="mt-1.5 border-t border-border pt-1.5">
          <p className={chipHeading}>Profiles</p>
          <div className="flex flex-wrap items-center gap-1 px-1">
            {preferences.profiles.map((profile) => (
              <span
                key={profile.id}
                className="inline-flex min-w-0 items-center overflow-hidden rounded-md border border-border"
              >
                <button
                  type="button"
                  data-testid={`chat-profile-${profile.id}`}
                  disabled={!ready || streaming}
                  title={[
                    agentLabel(profile.agent),
                    profile.model || "Agent default",
                    profile.effort,
                    profile.permissionMode &&
                      permissionText(profile.permissionMode, undefined).label,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  onClick={() => {
                    applyProfile(profile);
                    close();
                  }}
                  className={`${profileChip} min-w-0 truncate`}
                >
                  {profile.name}
                </button>
                <button
                  type="button"
                  data-testid={`chat-profile-delete-${profile.id}`}
                  aria-label={`Delete profile ${profile.name}`}
                  onClick={() =>
                    preferences.save((current) => ({
                      composer_profiles: (current.composer_profiles ?? []).filter(
                        (item) => item.id !== profile.id,
                      ),
                    }))
                  }
                  className={`${profileChip} border-l border-border text-muted-foreground`}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </span>
            ))}
            {naming === null ? (
              <button
                type="button"
                data-testid="chat-profile-new"
                onClick={() => setNaming("")}
                className={`${profileChip} gap-1 rounded-md text-muted-foreground`}
              >
                <Plus size={12} aria-hidden="true" />
                Save current
              </button>
            ) : (
              <form
                className="flex w-full min-w-0 gap-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (naming.trim()) saveProfile(naming.trim());
                }}
              >
                <Input
                  data-testid="chat-profile-name"
                  aria-label="Profile name"
                  placeholder="Profile name"
                  autoFocus
                  maxLength={60}
                  value={naming}
                  onChange={(event) => setNaming(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    setNaming(null);
                  }}
                  className="min-w-0"
                />
                <Button
                  type="submit"
                  data-testid="chat-profile-save"
                  disabled={!naming.trim()}
                  className="min-h-8 px-2"
                >
                  Save
                </Button>
              </form>
            )}
          </div>
          {preferences.error && (
            <p role="alert" className="px-2 pt-1 text-xs text-error">
              {preferences.error.message}
            </p>
          )}
        </div>
      )}
      selectedModel={config.model}
      agents={agents}
      choices={choices}
      descriptions={
        new Map(
          (catalog.data?.models ?? []).flatMap((entry) =>
            entry.description ? [[entry.id, entry.description] as const] : [],
          ),
        )
      }
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
      onModel={(model) => {
        const next = { ...config, model };
        setConfig(
          effortValue &&
            config.agent !== "opencode" &&
            !effortsFor(model).some((choice) => choice.value === effortValue)
            ? withAgentEffort(next, "")
            : next,
        );
      }}
      hasEfforts={(model) => effortsFor(model).length > 0}
      efforts={effortChoices}
      effort={effortValue}
      onEffort={(value) => {
        const next = withAgentEffort(config, value);
        setConfig(next);
        // Persist on the conversation right away; a send also carries the options,
        // so a failed save still applies on the next message.
        const options = next.agentOptions[config.agent];
        if (thread && options) void chat.applyAgentOptions(config.agent, options).catch(() => {});
      }}
    />
  );
}
