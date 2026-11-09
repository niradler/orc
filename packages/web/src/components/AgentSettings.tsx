import {
  AGENT_ID_PATTERN,
  CODING_AGENTS,
  enabledAgents,
  type ProviderPaths,
  ProviderPathsSchema,
  supportsManualCompaction,
} from "@orc/core/coding-agents";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { AgentIcon } from "@/components/AgentIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WORKSPACE_PREFERENCES_KEY } from "@/hooks/useAgents";

export function AgentSettings() {
  const client = useQueryClient();
  const preferences = useQuery({ queryKey: WORKSPACE_PREFERENCES_KEY, queryFn: api.settings.get });
  const [draft, setDraft] = useState<string[] | null>(null);
  const [custom, setCustom] = useState("");
  const [editing, setEditing] = useState("codex");
  const [pathsDraft, setPathsDraft] = useState<ProviderPaths | null>(null);
  const paths = pathsDraft ?? preferences.data?.provider_paths ?? {};
  const quotas = useQuery({
    queryKey: ["usage-quotas"],
    queryFn: api.settings.usageQuotas,
    enabled: false,
  });
  const quota = quotas.data?.accounts.find((account) => account.provider === editing);
  const savedAgents = enabledAgents(preferences.data?.agents);
  const selected = draft ?? savedAgents;
  const validatedPaths = ProviderPathsSchema.safeParse(paths);
  const pathError = validatedPaths.success
    ? undefined
    : validatedPaths.error.issues.find((issue) => issue.path[0] === editing)?.message;
  const savedPaths = preferences.data?.provider_paths ?? {};
  const dirty =
    selected.length !== savedAgents.length ||
    selected.some((agent) => !savedAgents.includes(agent)) ||
    (["codex", "claude"] as const).some(
      (agent) => (paths[agent]?.trim() ?? "") !== (savedPaths[agent] ?? ""),
    );
  const save = useMutation({
    mutationFn: (agents: string[]) => api.settings.save({ agents, provider_paths: paths }),
    onSuccess: async (saved) => {
      client.setQueryData(WORKSPACE_PREFERENCES_KEY, saved);
      setDraft(null);
      setPathsDraft(null);
      await client.invalidateQueries({ queryKey: WORKSPACE_PREFERENCES_KEY });
      await client.invalidateQueries({ queryKey: ["terminal-launchers"] });
      await client.invalidateQueries({ queryKey: ["terminals"] });
      await client.invalidateQueries({ queryKey: ["chat-models"] });
    },
  });
  const extra = [...new Set([...savedAgents, ...selected])].filter(
    (id) => !CODING_AGENTS.some((agent) => agent.id === id),
  );
  const toggle = (id: string, on: boolean) => {
    save.reset();
    setDraft(on ? [...selected, id] : selected.filter((value) => value !== id));
  };
  const addCustom = () => {
    const id = custom.trim().toLowerCase();
    if (!AGENT_ID_PATTERN.test(id) || selected.includes(id)) return;
    toggle(id, true);
    setEditing(id);
    setCustom("");
  };
  const busy = preferences.isPending || !!preferences.error || save.isPending;
  return (
    <section aria-labelledby="agent-settings-title" className="space-y-4">
      <div>
        <h2 id="agent-settings-title" className="text-base font-medium">
          Coding agents{" "}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {selected.length} enabled
          </span>
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose agents for chat, channels and terminals. Changes apply to new launches.
        </p>
      </div>
      {preferences.error && <p role="alert">{preferences.error.message}</p>}
      <div className="grid min-w-0 overflow-hidden rounded-md border border-border lg:grid-cols-[210px_minmax(0,1fr)]">
        <nav
          aria-label="Coding providers"
          className="flex overflow-x-auto border-b border-border lg:block lg:divide-y lg:divide-border lg:border-r lg:border-b-0"
        >
          {[...CODING_AGENTS.map((agent) => agent.id), ...extra].map((id) => {
            const agent = CODING_AGENTS.find((item) => item.id === id);
            return (
              <div
                key={id}
                className={`flex min-h-11 shrink-0 items-center gap-2 px-3 lg:min-w-0 ${editing === id ? "bg-surface-highest" : ""}`}
              >
                <button
                  type="button"
                  data-testid={`provider-select-${id}`}
                  aria-pressed={editing === id}
                  onClick={() => setEditing(id)}
                  className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <AgentIcon agent={id} size={16} />
                  <span className="min-w-0 truncate text-sm">{agent?.label ?? id}</span>
                </button>
                <label className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
                  <input
                    type="checkbox"
                    data-testid={`agent-enabled-${id}`}
                    className="accent-primary"
                    aria-label={`Enable ${agent?.label ?? id}`}
                    checked={selected.includes(id)}
                    disabled={busy || (!selected.includes(id) && selected.length >= 64)}
                    onChange={(event) => toggle(id, event.target.checked)}
                  />
                </label>
              </div>
            );
          })}
        </nav>
        <div className="min-w-0 space-y-5 p-4" data-testid="provider-editor">
          <div>
            <h3 className="text-sm font-medium">
              {CODING_AGENTS.find((agent) => agent.id === editing)?.label ?? editing}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {supportsManualCompaction(editing) ? "Native integration" : "Runs through acpx"}
            </p>
          </div>
          {editing === "claude" || editing === "codex" ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="provider-binary">Executable path</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="provider-use-default"
                  disabled={busy || !paths[editing]}
                  onClick={() => {
                    save.reset();
                    setPathsDraft({ ...paths, [editing]: "" });
                  }}
                >
                  Use default
                </Button>
              </div>
              <Input
                id="provider-binary"
                data-testid="provider-binary"
                value={paths[editing] ?? ""}
                placeholder={editing}
                maxLength={2048}
                disabled={busy}
                aria-invalid={!!pathError}
                aria-describedby={pathError ? "provider-binary-error" : "provider-binary-help"}
                onChange={(event) => {
                  save.reset();
                  setPathsDraft({ ...paths, [editing]: event.target.value });
                }}
              />
              {pathError && (
                <p id="provider-binary-error" role="alert" className="text-xs text-error">
                  {pathError}
                </p>
              )}
              <p id="provider-binary-help" className="text-xs text-muted-foreground">
                Local ORC host only. Leave blank to use the default installation. Enter a binary
                path, without arguments. SSH hosts use their own installation.
              </p>
              <p className="text-xs text-muted-foreground">
                Sign in with this agent’s CLI. ORC uses its existing account and configuration.
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Install this agent and configure its command in acpx on the execution host.
            </p>
          )}
          <div className="border-t border-border pt-4">
            <h4 className="text-sm font-medium">Context</h4>
            <p className="mt-1 text-xs text-muted-foreground">
              {supportsManualCompaction(editing)
                ? "Compact context from an idle conversation’s actions, or send /compact. Automatic compaction stays under the agent’s control."
                : "Manual compaction is not available through this integration."}
            </p>
          </div>
          {supportsManualCompaction(editing) && (
            <details className="border-t border-border pt-3">
              <summary className="min-h-11 cursor-pointer text-sm">Account limits</summary>
              <p className="mb-2 text-xs text-muted-foreground">
                Local account on the API host. Checked on request; SSH accounts are excluded.
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={quotas.isFetching}
                onClick={() => void quotas.refetch()}
              >
                {quotas.isFetching ? "Checking…" : "Check limits"}
              </Button>
              {quotas.isError && (
                <p role="alert" className="mt-2 text-xs text-error">
                  Limits could not be loaded. Try again.
                </p>
              )}
              {quota && (
                <div data-testid="provider-limits" className="mt-3 space-y-2 text-xs">
                  <p className="text-muted-foreground">
                    Checked {new Date(quota.checked_at).toLocaleTimeString()}
                  </p>
                  {quota.status !== "available" && (
                    <p>{quota.message ?? "Account limits are unavailable."}</p>
                  )}
                  {quota.windows.map((window) => (
                    <p key={window.label}>
                      {window.label}: {window.used_percent}% used
                      {window.resets_at
                        ? ` · Resets ${new Date(window.resets_at).toLocaleString()}`
                        : " · Reset time unavailable"}
                    </p>
                  ))}
                </div>
              )}
            </details>
          )}
        </div>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          addCustom();
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="agent-custom">Other acpx agent</Label>
          <Input
            id="agent-custom"
            data-testid="agent-custom"
            value={custom}
            placeholder="e.g. qoder"
            onChange={(event) => setCustom(event.target.value)}
            className="w-48"
          />
        </div>
        <Button
          type="submit"
          variant="outline"
          disabled={
            busy ||
            !AGENT_ID_PATTERN.test(custom.trim().toLowerCase()) ||
            selected.includes(custom.trim().toLowerCase()) ||
            selected.length >= 64
          }
        >
          Add
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-testid="agent-settings-save"
          disabled={busy || !dirty || !validatedPaths.success || selected.length === 0}
          onClick={() => save.mutate(selected)}
        >
          {save.isPending ? "Saving…" : "Save changes"}
        </Button>
        {dirty && (
          <Button
            type="button"
            variant="ghost"
            data-testid="provider-discard"
            disabled={save.isPending}
            onClick={() => {
              setDraft(null);
              setPathsDraft(null);
              save.reset();
            }}
          >
            Discard changes
          </Button>
        )}
        {selected.length === 0 && (
          <p className="text-xs text-muted-foreground">Enable at least one agent.</p>
        )}
        {save.isSuccess && (
          <p role="status" data-testid="agent-settings-saved">
            Provider settings saved.
          </p>
        )}
        {save.error && <p role="alert">{save.error.message}</p>}
      </div>
    </section>
  );
}
