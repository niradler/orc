import type { AgentPermission } from "@orc/core/agent-run";
import type { ComposerProfile } from "@orc/core/chat";
import type { JobAction } from "@orc/core/job-actions";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { AgentModelPicker } from "@/components/AgentModelPicker";
import { chipHeading } from "@/components/ComposerChip";
import { useAgentCapabilities } from "@/hooks/useAgentCapabilities";
import { useComposerPreferences, useEnabledAgents } from "@/hooks/useAgents";
import { useSsh } from "@/hooks/useSsh";
import { agentEffortChoices, effortFromOptions, liveEffortChoices } from "@/lib/composer-chips";

/** Job permissions have no plan/default row; only the granting modes map. */
function jobPermission(mode: ComposerProfile["permissionMode"]): AgentPermission | undefined {
  if (mode === "acceptEdits") return "accept_edits";
  if (mode === "auto" || mode === "bypassPermissions") return "auto";
  return undefined;
}

export function JobAgentPicker({
  value,
  onChange,
  host,
  cwd,
}: {
  value: Extract<JobAction, { type: "agent" }>;
  onChange: (action: JobAction) => void;
  host: string | null | undefined;
  cwd: string | undefined;
}) {
  const agent = value.agent === "codex-cli" ? "codex" : value.agent;
  const { data: ssh } = useSsh();
  const agents = Array.from(new Set([...useEnabledAgents(), agent]));
  const preferences = useComposerPreferences();
  const catalog = useQuery({
    queryKey: ["job-models", agent, host === undefined ? ssh?.host : host, cwd],
    queryFn: () => api.chat.models(agent, undefined, host, cwd),
    staleTime: 120000,
    retry: false,
  });
  const choices = new Map((catalog.data?.models ?? []).map((entry) => [entry.id, entry.label]));
  if (value.model && !choices.has(value.model)) choices.set(value.model, value.model);
  const capabilities = useAgentCapabilities(agent);
  const fixed = capabilities?.modelSelection === false;
  const models = catalog.data?.models ?? [];
  const effortChoicesFor = (forAgent: string, model: string) => {
    if (forAgent === "opencode")
      return forAgent === agent
        ? liveEffortChoices(capabilities?.effortChoices ?? catalog.data?.effortChoices)
        : [];
    // A different agent's catalog has not been fetched, so fall back to its
    // runtime's known levels.
    if (forAgent !== agent) return agentEffortChoices(forAgent);
    const entry = models.find((item) => item.id === model);
    return agentEffortChoices(
      forAgent,
      entry && (entry.efforts ?? (models.some((item) => item.efforts) ? [] : undefined)),
    );
  };
  const selectedEffort = value.effort ?? effortFromOptions(value.options);
  const applyProfile = (profile: ComposerProfile) => {
    const permission = jobPermission(profile.permissionMode);
    const nextAgent = profile.agent === "codex" ? "codex-cli" : profile.agent;
    const model = profile.model || undefined;
    const allowed = effortChoicesFor(profile.agent, model ?? "");
    const effort =
      profile.effort && allowed.length && !allowed.some((choice) => choice.value === profile.effort)
        ? undefined
        : profile.effort || undefined;
    onChange({
      ...value,
      agent: nextAgent,
      model,
      effort: effort ?? "",
      // Launch options belong to the old agent, so they cannot carry over.
      ...(nextAgent !== value.agent ? { options: undefined } : {}),
      ...(permission ? { permissions: permission } : {}),
    });
  };
  return (
    <AgentModelPicker
      testIdPrefix="job"
      showAgent
      wide
      agent={agent}
      selectedModel={value.model ?? ""}
      agents={agents}
      choices={choices}
      descriptions={
        new Map(
          (catalog.data?.models ?? []).flatMap((entry) =>
            entry.description ? [[entry.id, entry.description] as const] : [],
          ),
        )
      }
      efforts={effortChoicesFor(agent, value.model ?? "")}
      effort={selectedEffort}
      onEffort={(effort) => onChange({ ...value, effort })}
      hasEfforts={(model) => effortChoicesFor(agent, model).length > 0}
      fetching={catalog.isFetching}
      modelsDisabled={fixed}
      warning={
        catalog.isError
          ? "Models could not be loaded. Saved and custom models are available."
          : catalog.data?.warning
      }
      note={fixed ? "This agent picks its own model." : undefined}
      footer={(close) =>
        preferences.profiles.length ? (
          <div data-testid="job-profiles" className="mt-1.5 border-t border-border pt-1.5">
            <p className={chipHeading}>Profiles</p>
            <div className="flex flex-wrap items-center gap-1 px-1">
              {preferences.profiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  data-testid={`job-profile-${profile.id}`}
                  onClick={() => {
                    applyProfile(profile);
                    close();
                  }}
                  title={[profile.model || "Agent default", profile.effort, profile.permissionMode]
                    .filter(Boolean)
                    .join(" · ")}
                  className="inline-flex min-h-8 max-w-full items-center truncate rounded-md border border-border px-2 text-xs hover:bg-surface-highest focus-visible:outline-2 focus-visible:outline-focus max-sm:min-h-11"
                >
                  {profile.name}
                </button>
              ))}
            </div>
          </div>
        ) : null
      }
      onAgent={(next) => {
        if (next !== agent)
          onChange({
            ...value,
            agent: next === "codex" ? "codex-cli" : next,
            model: undefined,
            effort: undefined,
            options: undefined,
          });
        return false;
      }}
      onModel={(model) => {
        const supported = effortChoicesFor(agent, model).some(
          (choice) => choice.value === selectedEffort,
        );
        onChange({
          ...value,
          model: model || undefined,
          ...(selectedEffort && !supported ? { effort: "" } : {}),
        });
      }}
    />
  );
}
