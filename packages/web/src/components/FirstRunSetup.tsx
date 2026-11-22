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
  const [selected, setSelected] = useState<Set<number> | null>(null);
  const [rows, setRows] = useState<Record<number, RowState>>({});
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
  const checked = selected ?? new Set(suggestions.map((_, index) => index));
  const readyCount = agents.filter((agent) => agent.installed && agent.signed_in !== false).length;
  const setRow = (index: number, state: RowState) =>
    setRows((current) => ({ ...current, [index]: state }));

  async function createSelected(): Promise<void> {
    setCreating(true);
    const targets = suggestions
      .map((suggestion, index) => ({ suggestion, index }))
      .filter(({ index }) => checked.has(index) && rows[index]?.status !== "created");
    let created = 0;
    // One at a time so a rejected name does not race the rest, and each row can
    // report its own outcome; failures stay selected for retry.
    for (const { suggestion, index } of targets) {
      setRow(index, { status: "creating" });
      try {
        await api.projects.create({ name: suggestion.name, scope: suggestion.path });
        created += 1;
        setRow(index, { status: "created" });
      } catch (error) {
        setRow(index, {
          status: "error",
          error: error instanceof Error ? error.message : "Could not create the project",
        });
      }
    }
    setCreating(false);
    if (created > 0) {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["setup-status"] });
    }
  }

  return (
    <section
      data-testid="first-run-setup"
      aria-labelledby="first-run-title"
      className="w-full space-y-6"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1">
          <h1 id="first-run-title" className="text-[22px] leading-tight font-medium">
            Set up ORC
          </h1>
          <HelpPopover label="First-run setup" testId="first-run-help">
            ORC detected the coding agents installed on this machine and the folders their own
            session history shows they were last used in. Create projects from the suggestions to
            group their tasks, sessions and knowledge, and pick the agent new chats start with.
            Dismiss hides this screen; it stays hidden until a project exists.
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
                    aria-label={`Copy ${agent.label} fix command`}
                    data-testid={`first-run-fix-copy-${agent.agent}`}
                    onClick={() => void navigator.clipboard.writeText(agent.fix?.command ?? "")}
                  >
                    <Copy size={14} aria-hidden />
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
                const row = rows[index] ?? { status: "idle" };
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
                        checked={checked.has(index) && row.status !== "created"}
                        disabled={creating || row.status === "created"}
                        onChange={(event) => {
                          const next = new Set(checked);
                          if (event.target.checked) next.add(index);
                          else next.delete(index);
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
                disabled={creating || checked.size === 0}
                onClick={() => void createSelected()}
              >
                {creating
                  ? "Creating…"
                  : `Create ${checked.size} project${checked.size === 1 ? "" : "s"}`}
              </Button>
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
