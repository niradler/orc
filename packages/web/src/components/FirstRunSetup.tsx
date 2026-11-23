import type { SetupAgent, SetupProjectSuggestion } from "@orc/sdk/types";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Circle, Copy, Smartphone, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api/client";
import { AgentIcon } from "@/components/AgentIcon";
import { ErrorState } from "@/components/ErrorState";
import { HelpPopover } from "@/components/HelpPopover";
import { Button } from "@/components/ui/button";
import { useDismissSetup, useSetDefaultAgent, useSetupStatus } from "@/hooks/useSetup";
import { formatWhen } from "@/lib/live-sessions";
import { cn } from "@/lib/utils";

type RowState =
  | { status: "idle" }
  | { status: "creating" }
  | { status: "created" }
  | { status: "error"; error: string };

function statusParts(agent: SetupAgent): string[] {
  if (!agent.installed) return ["Not installed"];
  const parts = ["Installed"];
  if (agent.signed_in === true)
    parts.push(agent.account_label ? `Signed in as ${agent.account_label}` : "Signed in");
  else if (agent.signed_in === false) parts.push("Not signed in");
  else parts.push("Sign-in not detected");
  if (agent.version) parts.push(`v${agent.version}`);
  return parts;
}

function StatusMark({ agent }: { agent: SetupAgent }) {
  if (!agent.installed)
    return <Circle size={14} className="shrink-0 text-muted-foreground" aria-hidden />;
  if (agent.signed_in === false)
    return <AlertCircle size={14} className="shrink-0 text-warning" aria-hidden />;
  return <Check size={14} className="shrink-0 text-success" aria-hidden />;
}

export function FirstRunSetup() {
  const queryClient = useQueryClient();
  const setup = useSetupStatus();
  const dismiss = useDismissSetup();
  const defaultAgent = useSetDefaultAgent();
  const [openFix, setOpenFix] = useState<string | null>(null);
  const [copiedFix, setCopiedFix] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [creating, setCreating] = useState(false);

  if (setup.isPending)
    return (
      <section data-testid="first-run-setup" aria-label="Set up ORC">
        <p role="status" className="p-6 text-sm text-muted-foreground">
          Detecting your coding agents…
        </p>
      </section>
    );
  if (setup.isError || !setup.data)
    return (
      <section data-testid="first-run-setup" aria-label="Set up ORC">
        <ErrorState
          message="Setup status could not be loaded."
          onRetry={() => void setup.refetch()}
        />
      </section>
    );

  const { agents, suggestions, default_agent: defaultAgentId } = setup.data;
  const checked = selected ?? new Set(suggestions.map((suggestion) => suggestion.path));
  const pendingSelected = suggestions.filter(
    (suggestion) => checked.has(suggestion.path) && rows[suggestion.path]?.status !== "created",
  );
  const hasCreated = suggestions.some((suggestion) => rows[suggestion.path]?.status === "created");
  const hasFailed = suggestions.some((suggestion) => rows[suggestion.path]?.status === "error");
  const readyCount = agents.filter((agent) => agent.installed && agent.signed_in !== false).length;
  const setRow = (path: string, state: RowState) =>
    setRows((current) => ({ ...current, [path]: state }));
  const canBeDefault = (agent: string) =>
    defaultAgent.providers.data?.providers.some(
      (profile) => profile.agent === agent && profile.enabled,
    ) ?? false;

  async function finishSetup(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ["projects"] });
    void queryClient.invalidateQueries({ queryKey: ["setup-status"] });
  }

  async function createSelected(): Promise<void> {
    setCreating(true);
    let created = 0;
    let failed = 0;
    for (const suggestion of pendingSelected) {
      setRow(suggestion.path, { status: "creating" });
      try {
        await api.projects.create({ name: suggestion.name, scope: suggestion.path });
        created += 1;
        setRow(suggestion.path, { status: "created" });
      } catch (error) {
        failed += 1;
        setRow(suggestion.path, {
          status: "error",
          error: error instanceof Error ? error.message : "Could not create the project",
        });
      }
    }
    setCreating(false);
    if (created > 0 && failed === 0) await finishSetup();
  }

  return (
    <section
      data-testid="first-run-setup"
      aria-labelledby="first-run-title"
      className="w-full space-y-6"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1">
          <h2 id="first-run-title" className="text-[22px] leading-tight font-medium">
            Set up ORC
          </h2>
          <HelpPopover label="First-run setup" testId="first-run-help">
            ORC detected your installed coding agents and recent session folders. Create projects
            from suggestions to group tasks, sessions and knowledge, or dismiss until a project
            exists.
          </HelpPopover>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Dismiss setup"
          data-testid="first-run-dismiss"
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate()}
        >
          <X size={16} aria-hidden />
        </Button>
      </div>
      {dismiss.isError && (
        <p role="alert" className="text-xs text-error">
          {dismiss.error.message}
        </p>
      )}

      <section aria-labelledby="first-run-agents-title" className="space-y-2">
        <div className="flex items-center gap-2">
          <h2 id="first-run-agents-title" className="text-base font-medium">
            Coding agents
          </h2>
          <span className="text-xs text-muted-foreground" data-testid="first-run-agents-ready">
            {readyCount} of {agents.length} ready
          </span>
        </div>
        <div className="divide-y divide-border rounded-md border border-border">
          {agents.map((agent) => (
            <div
              key={agent.agent}
              data-testid={`first-run-agent-${agent.agent}`}
              className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2"
            >
              <AgentIcon agent={agent.agent} decorative size={16} />
              <span className="text-sm font-medium">{agent.label}</span>
              <span
                data-testid={`first-run-agent-status-${agent.agent}`}
                className={cn(
                  "flex min-w-0 items-center gap-1.5 text-xs",
                  !agent.installed && "text-muted-foreground",
                  agent.installed && agent.signed_in === false && "text-warning",
                )}
              >
                <StatusMark agent={agent} />
                <span className="truncate">{statusParts(agent).join(" · ")}</span>
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {agent.fix &&
                  (openFix === agent.agent ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid={`first-run-fix-${agent.agent}`}
                      onClick={() => setOpenFix(null)}
                    >
                      Hide
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid={`first-run-fix-${agent.agent}`}
                      onClick={() => setOpenFix(agent.agent)}
                    >
                      {agent.fix.label}
                    </Button>
                  ))}
                {agent.installed &&
                  agent.signed_in !== false &&
                  canBeDefault(agent.agent) &&
                  (defaultAgentId === agent.agent ? (
                    <span
                      className="px-2 text-xs text-muted-foreground"
                      data-testid={`first-run-default-${agent.agent}`}
                    >
                      Default
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid={`first-run-default-${agent.agent}`}
                      disabled={defaultAgent.save.isPending}
                      onClick={() => defaultAgent.save.mutate(agent.agent)}
                    >
                      Make default
                    </Button>
                  ))}
              </span>
              {openFix === agent.agent && agent.fix && (
                <span className="flex w-full items-start gap-2">
                  <code
                    className="min-w-0 flex-1 rounded bg-surface-highest px-2 py-1 break-all font-mono text-[11px]"
                    data-testid={`first-run-fix-command-${agent.agent}`}
                  >
                    {agent.fix.command}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={
                      copiedFix === agent.agent
                        ? `Copied ${agent.label} fix command`
                        : `Copy ${agent.label} fix command`
                    }
                    data-testid={`first-run-fix-copy-${agent.agent}`}
                    onClick={() => {
                      const command = agent.fix?.command ?? "";
                      void navigator.clipboard
                        ?.writeText(command)
                        .then(() => {
                          setCopiedFix(agent.agent);
                          setTimeout(() => {
                            setCopiedFix((current) => (current === agent.agent ? null : current));
                          }, 2000);
                        })
                        .catch(() => {});
                    }}
                  >
                    {copiedFix === agent.agent ? (
                      <Check size={14} aria-hidden />
                    ) : (
                      <Copy size={14} aria-hidden />
                    )}
                  </Button>
                </span>
              )}
            </div>
          ))}
        </div>
        {defaultAgent.save.isError && (
          <p role="alert" className="text-xs text-error">
            {defaultAgent.save.error.message}
          </p>
        )}
      </section>

      <section aria-labelledby="first-run-projects-title" className="space-y-2">
        <div className="flex items-center gap-1">
          <h2 id="first-run-projects-title" className="text-base font-medium">
            Suggested projects
          </h2>
          <HelpPopover label="Suggested projects" testId="first-run-suggestions-help">
            Folders your agents were last used in, from their own local session history. Each
            project's folder becomes its scope, so ORC assigns future sessions, tasks and
            notifications in that folder to it automatically.
          </HelpPopover>
          {suggestions.length > 0 && (
            <span className="text-xs text-muted-foreground">{suggestions.length}</span>
          )}
        </div>
        {suggestions.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="first-run-no-suggestions">
            No recent agent folders found yet.{" "}
            <Link to="/projects" className="underline">
              Create a project manually
            </Link>
            .
          </p>
        ) : (
          <>
            <div className="divide-y divide-border rounded-md border border-border">
              {suggestions.map((suggestion: SetupProjectSuggestion, index: number) => {
                const row = rows[suggestion.path] ?? { status: "idle" };
                return (
                  <div
                    key={suggestion.path}
                    data-testid={`first-run-suggestion-${index}`}
                    className="flex min-h-11 items-center gap-2 px-3 py-2"
                  >
                    <label className="flex min-h-11 min-w-11 flex-1 cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        className="size-4 shrink-0 accent-primary"
                        aria-label={`Create project ${suggestion.name}`}
                        data-testid={`first-run-suggestion-check-${index}`}
                        checked={checked.has(suggestion.path) && row.status !== "created"}
                        disabled={creating || row.status === "created"}
                        onChange={(event) => {
                          const next = new Set(checked);
                          if (event.target.checked) next.add(suggestion.path);
                          else next.delete(suggestion.path);
                          setSelected(next);
                        }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{suggestion.name}</span>
                        <span
                          className="block truncate text-xs text-muted-foreground"
                          title={suggestion.path}
                        >
                          {suggestion.path}
                        </span>
                      </span>
                    </label>
                    <span className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                      {suggestion.agents.map((id) => (
                        <AgentIcon key={id} agent={id} decorative size={14} />
                      ))}
                      <span>
                        {suggestion.sessions} session{suggestion.sessions === 1 ? "" : "s"} ·{" "}
                        {formatWhen(suggestion.last_activity_at)}
                      </span>
                    </span>
                    {row.status === "created" && (
                      <span
                        className="flex shrink-0 items-center gap-1 text-xs text-success"
                        data-testid={`first-run-suggestion-created-${index}`}
                      >
                        <Check size={14} aria-hidden /> Created
                      </span>
                    )}
                    {row.status === "error" && (
                      <span
                        role="alert"
                        className="min-w-0 shrink text-xs text-error"
                        data-testid={`first-run-suggestion-error-${index}`}
                      >
                        {row.error}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                data-testid="first-run-create"
                disabled={creating || pendingSelected.length === 0}
                onClick={() => void createSelected()}
              >
                {creating
                  ? "Creating…"
                  : `Create ${pendingSelected.length} project${pendingSelected.length === 1 ? "" : "s"}`}
              </Button>
              {hasCreated && hasFailed && (
                <Button
                  variant="ghost"
                  data-testid="first-run-continue"
                  disabled={creating}
                  onClick={() => void finishSetup()}
                >
                  Continue to Activity
                </Button>
              )}
              <span className="text-xs text-muted-foreground">
                Uses the suggested name and folder; edit anything later in Projects.
              </span>
            </div>
          </>
        )}
      </section>

      <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Smartphone size={16} aria-hidden />
        <span data-testid="first-run-phone">
          Away from this machine? Connect a channel to reach ORC from your phone.
        </span>
        <Link
          to="/settings?settingsSection=channels"
          className="underline"
          data-testid="first-run-phone-link"
        >
          Open channels
        </Link>
      </p>
    </section>
  );
}
