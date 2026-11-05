import { AGENT_ID_PATTERN, CODING_AGENTS, enabledAgents } from "@orc/core/coding-agents";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WORKSPACE_PREFERENCES_KEY } from "@/hooks/useAgents";

export function AgentSettings() {
  const client = useQueryClient();
  const preferences = useQuery({ queryKey: WORKSPACE_PREFERENCES_KEY, queryFn: api.settings.get });
  const [draft, setDraft] = useState<string[] | null>(null);
  const [custom, setCustom] = useState("");
  const selected = draft ?? enabledAgents(preferences.data?.agents);
  const save = useMutation({
    mutationFn: (agents: string[]) => api.settings.save({ agents }),
    onSuccess: async () => {
      setDraft(null);
      await client.invalidateQueries({ queryKey: WORKSPACE_PREFERENCES_KEY });
      await client.invalidateQueries({ queryKey: ["terminal-launchers"] });
      await client.invalidateQueries({ queryKey: ["terminals"] });
    },
  });
  const extra = selected.filter((id) => !CODING_AGENTS.some((agent) => agent.id === id));
  const toggle = (id: string, on: boolean) => {
    save.reset();
    setDraft(on ? [...selected, id] : selected.filter((value) => value !== id));
  };
  const addCustom = () => {
    const id = custom.trim().toLowerCase();
    if (!AGENT_ID_PATTERN.test(id) || selected.includes(id)) return;
    toggle(id, true);
    setCustom("");
  };
  const busy = preferences.isPending || !!preferences.error || save.isPending;
  return (
    <section aria-labelledby="agent-settings-title" className="space-y-4">
      <div>
        <h2 id="agent-settings-title" className="text-base font-medium">
          Coding agents
        </h2>
        <p className="mt-1 text-sm text-outline">
          Enabled agents appear in the chat agent picker, channel agent choices and the terminal
          launcher (when installed on the host). Claude and Codex use native integrations; every
          other agent runs through acpx.
        </p>
      </div>
      {preferences.error && <p role="alert">{preferences.error.message}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        {[...CODING_AGENTS.map((agent) => agent.id), ...extra].map((id) => {
          const agent = CODING_AGENTS.find((item) => item.id === id);
          return (
            <label
              key={id}
              className="flex min-h-11 items-center gap-3 rounded-md border border-border px-3 py-2"
            >
              <input
                type="checkbox"
                data-testid={`agent-enabled-${id}`}
                className="accent-primary"
                checked={selected.includes(id)}
                disabled={busy}
                onChange={(event) => toggle(id, event.target.checked)}
              />
              <span className="min-w-0">
                <span className="block text-sm">{agent?.label ?? id}</span>
                <span className="block text-xs text-muted-foreground">
                  {agent
                    ? `${agent.chatRuntime === "acpx" ? "acpx" : "native"} · ${agent.binaries.join(" / ")}`
                    : "acpx · custom"}
                </span>
              </span>
            </label>
          );
        })}
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
          disabled={busy || !AGENT_ID_PATTERN.test(custom.trim().toLowerCase())}
        >
          Add
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-testid="agent-settings-save"
          disabled={busy || !draft || selected.length === 0}
          onClick={() => save.mutate(selected)}
        >
          {save.isPending ? "Saving…" : "Save agents"}
        </Button>
        {selected.length === 0 && (
          <p className="text-xs text-muted-foreground">Enable at least one agent.</p>
        )}
        {save.isSuccess && (
          <p role="status" data-testid="agent-settings-saved">
            Agents saved.
          </p>
        )}
        {save.error && <p role="alert">{save.error.message}</p>}
      </div>
    </section>
  );
}
