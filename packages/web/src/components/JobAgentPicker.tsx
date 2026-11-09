import type { JobAction } from "@orc/core/job-actions";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { AgentModelPicker } from "@/components/AgentModelPicker";
import { useAgentCapabilities } from "@/hooks/useAgentCapabilities";
import { useEnabledAgents } from "@/hooks/useAgents";
import { useSsh } from "@/hooks/useSsh";

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
  const agent = value.backend === "codex-cli" ? "codex" : value.backend;
  const { data: ssh } = useSsh();
  const agents = Array.from(new Set([...useEnabledAgents(), agent]));
  const catalog = useQuery({
    queryKey: ["job-models", agent, host === undefined ? ssh?.host : host, cwd],
    queryFn: () => api.chat.models(agent, undefined, host, cwd),
    staleTime: 120000,
    retry: false,
  });
  const choices = new Map((catalog.data?.models ?? []).map((entry) => [entry.id, entry.label]));
  if (value.model && !choices.has(value.model)) choices.set(value.model, value.model);
  const fixed = useAgentCapabilities(agent)?.modelSelection === false;
  return (
    <AgentModelPicker
      testIdPrefix="job"
      agent={agent}
      selectedModel={value.model ?? ""}
      agents={agents}
      choices={choices}
      fetching={catalog.isFetching}
      modelsDisabled={fixed}
      warning={
        catalog.isError
          ? "Models could not be loaded. Saved and custom models are available."
          : catalog.data?.warning
      }
      note={fixed ? "This agent picks its own model." : undefined}
      onAgent={(next) => {
        if (next !== agent)
          onChange({
            ...value,
            backend: next === "codex" ? "codex-cli" : next,
            model: undefined,
            options: undefined,
          });
        return false;
      }}
      onModel={(model) => onChange({ ...value, model: model || undefined })}
    />
  );
}
