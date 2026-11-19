import type { AgentPermission, AgentRun } from "@orc/core/agent-run";
import { ChatSettingsSchema } from "@orc/core/chat";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api } from "@/api/client";
import { HelpPopover } from "@/components/HelpPopover";
import { useEnabledAgents } from "@/hooks/useAgents";
import { useBackends } from "@/hooks/useBackends";
import { agentEffortChoices, agentEffortValue, withAgentEffort } from "@/lib/composer-chips";

type Run = Pick<AgentRun, "agent" | "model" | "profile" | "options" | "permissions">;

const control = "form-control form-control-single w-full";
export const permissionLabels: Record<AgentPermission, string> = {
  ask: "Ask me to approve tools",
  read_only: "Read-only tools",
  accept_edits: "Accept edits",
  auto: "Approve everything",
};

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1 text-sm">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

export function AgentRunEditor<T extends Run>({
  value,
  onChange,
  testId,
}: {
  value: T;
  onChange: (value: T) => void;
  testId: string;
}) {
  const enabled = useEnabledAgents();
  const { data: backends } = useBackends();
  const agents = Array.from(
    new Set([
      "default",
      ...enabled,
      ...(backends?.backends.map((backend) => backend.name) ?? []),
      value.agent,
    ]),
  );
  const custom = value.agent !== "default";
  const models = useQuery({
    queryKey: ["chat-models", value.agent],
    queryFn: () => api.chat.models(value.agent),
    enabled: custom,
    staleTime: 60_000,
  });
  const settings = ChatSettingsSchema.parse({
    agent: custom ? value.agent : "codex",
    agentOptions: custom && value.options ? { [value.agent]: value.options } : {},
  });
  const efforts = custom
    ? agentEffortChoices(
        value.agent,
        models.data?.models.find((m) => m.id === value.model)?.efforts ??
          models.data?.effortChoices?.map((c) => c.value),
      )
    : [];
  const set = (patch: Partial<Run>) => {
    const next = { ...value, ...patch };
    for (const key of ["model", "profile", "options"] as const)
      if (next[key] === undefined || next[key] === "") delete next[key];
    onChange(next);
  };
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid={testId}>
      <Field label="Agent" id={`${testId}-agent`}>
        <select
          id={`${testId}-agent`}
          data-testid={`${testId}-agent`}
          className={control}
          value={value.agent}
          onChange={(e) => set({ agent: e.target.value, model: undefined, options: undefined })}
        >
          {agents.map((agent) => (
            <option key={agent} value={agent}>
              {agent === "default" ? "Default (Chat Settings)" : agent}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Model" id={`${testId}-model`}>
        <select
          id={`${testId}-model`}
          data-testid={`${testId}-model`}
          className={control}
          value={value.model ?? ""}
          disabled={!custom}
          onChange={(e) => set({ model: e.target.value || undefined })}
        >
          <option value="">{custom ? "Agent default" : "From Chat Settings"}</option>
          {value.model && !models.data?.models.some((m) => m.id === value.model) && (
            <option value={value.model}>{value.model}</option>
          )}
          {models.data?.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Effort" id={`${testId}-effort`}>
        <select
          id={`${testId}-effort`}
          data-testid={`${testId}-effort`}
          className={control}
          value={agentEffortValue(settings)}
          disabled={!efforts.length}
          onChange={(e) =>
            set({
              options: withAgentEffort(settings, e.target.value).agentOptions[value.agent],
            })
          }
        >
          <option value="">{efforts.length ? "Agent default" : "Not adjustable"}</option>
          {efforts.map((effort) => (
            <option key={effort.value} value={effort.value}>
              {effort.label}
            </option>
          ))}
        </select>
      </Field>
      <AgentRunAccessFields
        value={value}
        onChange={set}
        testId={testId}
        help="Read-only limits the agent to reading and searching. People matched only by “Any sender” never get more than read-only."
      />
    </div>
  );
}

export function AgentRunAccessFields({
  value,
  onChange,
  testId,
  help,
}: {
  value: Pick<Run, "profile" | "permissions">;
  onChange: (patch: Partial<Run>) => void;
  testId: string;
  help: string;
}) {
  const profiles = useQuery({ queryKey: ["agents"], queryFn: () => api.agents.list() });
  return (
    <>
      <Field label="Persona (agent profile)" id={`${testId}-profile`}>
        <select
          id={`${testId}-profile`}
          data-testid={`${testId}-profile`}
          className={control}
          value={value.profile ?? ""}
          onChange={(e) => onChange({ profile: e.target.value || undefined })}
        >
          <option value="">None</option>
          {value.profile && !profiles.data?.agents.some((a) => a.id === value.profile) && (
            <option value={value.profile}>{value.profile}</option>
          )}
          {profiles.data?.agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid min-w-0 gap-1 text-sm">
        <span className="flex items-center gap-1">
          <label htmlFor={`${testId}-permissions`}>Permissions</label>
          <HelpPopover label="Permissions" testId={`${testId}-permissions-help`}>
            {help}
          </HelpPopover>
        </span>
        <select
          id={`${testId}-permissions`}
          data-testid={`${testId}-permissions`}
          className={control}
          value={value.permissions}
          onChange={(e) => onChange({ permissions: e.target.value as AgentPermission })}
        >
          {Object.entries(permissionLabels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
