import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { type AgentFull, api } from "@/api/client";
import { AgentEditor } from "@/components/AgentEditor";
import { CodeEditor } from "@/components/CodeEditor";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ViewHeader } from "@/components/ViewHeader";
import { useDetailRoute } from "@/hooks/useDetailRoute";
import { useViewParam } from "@/lib/view-params";
import { workspaceDestination } from "@/lib/workspace-navigation";

export default function Agents({ embedded = false }: { embedded?: boolean }) {
  const location = useLocation();
  const projectId = new URLSearchParams(location.search).get("project") ?? "all";
  const [editorMode, setEditorMode] = useViewParam<"read" | "edit" | "split">(
    "editorMode",
    "read",
    ["read", "edit", "split"],
  );
  const [query, setQuery] = useViewParam<string>("agentQuery", "");
  const cache = useQueryClient();
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents.list(),
    refetchInterval: 60_000,
  });
  const { selectedId, openDetail, closeDetail } = useDetailRoute(
    embedded ? "/packages/agents" : "/agents",
    "agentId",
  );
  const agent = useQuery({
    queryKey: ["agent", selectedId],
    queryFn: () => api.agents.get(selectedId as string),
    enabled: Boolean(selectedId),
  });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AgentFull>();
  const [deleting, setDeleting] = useState(false);
  const create = useMutation({
    mutationFn: api.agents.create,
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["agents"] });
      setCreating(false);
    },
  });
  const deleteAgent = useMutation({
    mutationFn: api.agents.delete,
    onSuccess: () => {
      setDeleting(false);
      closeDetail();
      void cache.invalidateQueries({ queryKey: ["agents"] });
      void cache.invalidateQueries({ queryKey: ["agent-packages"] });
      void cache.invalidateQueries({ queryKey: ["agent"] });
    },
  });
  const update = useMutation({
    mutationFn: ({ profile, content }: { profile: AgentFull; content: string }) =>
      api.agents.update(profile.id, {
        content,
        expectedRaw: profile.raw,
        expectedPath: profile.path,
      }),
    onSuccess: (profile) => {
      cache.setQueryData(["agent", profile.id], profile);
      void cache.invalidateQueries({ queryKey: ["agents"] });
      void cache.invalidateQueries({ queryKey: ["agent-packages"] });
      setEditing(undefined);
    },
  });
  if (agents.error)
    return <ErrorState message={agents.error.message} onRetry={() => void agents.refetch()} />;
  const visible = (agents.data?.agents ?? []).filter((profile) =>
    `${profile.name} ${profile.id} ${profile.description}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div className="space-y-5">
      {embedded ? (
        <div className="flex flex-wrap justify-between gap-3">
          <div>
            <h2 className="font-medium">Agent definitions</h2>
            <p className="text-sm text-muted-foreground">
              Manage specialist instructions, models and tools. Add them to APM packages for reuse.
            </p>
          </div>
          <Button
            data-testid="new-agent-button"
            onClick={() => {
              create.reset();
              setCreating(true);
            }}
          >
            New agent
          </Button>
        </div>
      ) : (
        <ViewHeader
          title="Agents"
          meta={`${agents.data?.agents.length ?? 0} shared profiles`}
          action={
            <div className="flex flex-wrap gap-2">
              <Button
                data-testid="new-agent-button"
                onClick={() => {
                  create.reset();
                  setCreating(true);
                }}
              >
                New agent
              </Button>
            </div>
          }
        />
      )}
      <p className="text-sm text-muted-foreground">
        Shared specialist definitions for every connected coding agent.{" "}
        <a
          className="text-primary underline"
          href="https://microsoft.github.io/apm/producer/author-primitives/instructions-and-agents/"
          target="_blank"
          rel="noreferrer"
        >
          APM agent format
        </a>
      </p>
      {!embedded && (
        <Link
          to={workspaceDestination("/packages", projectId, location.search)}
          data-testid="agents-packages-link"
          className="text-primary underline"
        >
          Manage packages and reusable launch setups
        </Link>
      )}
      {(agents.data?.broken ?? []).map((issue) => (
        <p key={issue.path} role="alert" className="text-destructive">
          {issue.path}: {issue.error}
        </p>
      ))}
      <div className="flex flex-wrap gap-2">
        <Input
          className="min-w-[180px] max-w-lg flex-1"
          aria-label="Find an agent"
          placeholder="Find an agent by name or purpose…"
          value={query}
          onChange={(event) => setQuery(event.target.value, { replace: true })}
        />
        {query && (
          <Button variant="ghost" onClick={() => setQuery("")}>
            Clear
          </Button>
        )}
      </div>
      <div className="space-y-2">
        {agents.isLoading && (
          <p role="status" data-testid="page-loading">
            Loading agents…
          </p>
        )}
        {visible.map((profile) => (
          <button
            key={profile.id}
            type="button"
            data-testid="agent-row"
            data-agent-id={profile.id}
            onClick={() => openDetail(profile.id)}
            className="w-full text-left border-b border-outline-variant p-4 hover:bg-surface-low"
          >
            <span className="block break-words text-base font-medium">{profile.name}</span>
            <span className="mt-1 block break-all text-xs text-muted-foreground">
              {profile.id} · {profile.source}
            </span>
            <p className="mt-2 break-words text-sm leading-relaxed text-muted-foreground">
              {profile.description}
            </p>
          </button>
        ))}
        {!agents.isLoading && !visible.length && (
          <p data-testid="page-empty" className="text-sm text-muted-foreground">
            {query
              ? "No agents match this search. Try another name or clear the filter."
              : "Create an agent or import specialists from Packages."}
          </p>
        )}
      </div>
      <Sheet open={Boolean(selectedId)} onOpenChange={(open) => !open && closeDetail()}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{agent.data?.name ?? "Agent profile"}</SheetTitle>
          </SheetHeader>
          <SheetBody>
            {agent.error ? (
              <ErrorState message={agent.error.message} onRetry={() => void agent.refetch()} />
            ) : agent.data ? (
              <div className="space-y-4">
                <p className="text-sm">{agent.data.description}</p>
                <Button
                  data-testid="agent-edit"
                  variant="outline"
                  onClick={async () => {
                    update.reset();
                    const current = await agent.refetch();
                    if (current.data) setEditing(current.data);
                  }}
                >
                  Edit agent
                </Button>
                <Button
                  data-testid="agent-delete"
                  variant="destructive"
                  onClick={() => {
                    deleteAgent.reset();
                    setDeleting(true);
                  }}
                  disabled={deleteAgent.isPending}
                >
                  Delete agent
                </Button>
                {deleteAgent.error && (
                  <p data-testid="agent-delete-error" role="alert" className="text-destructive">
                    {deleteAgent.error.message}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Use this profile in a flow agent node with <code>"agent": "{agent.data.id}"</code>{" "}
                  and choose the coding backend independently.
                </p>
                <p className="text-xs text-muted-foreground">
                  Model and tool restrictions depend on backend support. ORC refuses to launch when
                  it cannot honor a declared restriction. Handoffs remain declarations; flow edges
                  choose execution.
                </p>
                <CodeEditor
                  path="metadata.json"
                  value={JSON.stringify(agent.data.fields, null, 2)}
                  readOnly
                  height={180}
                  testId="agent-fields"
                />
                <CodeEditor
                  path="agent.agent.md"
                  mode={editorMode}
                  onModeChange={setEditorMode}
                  value={agent.data.raw}
                  readOnly
                  height={400}
                  testId="agent-content"
                />
              </div>
            ) : (
              <p>Loading...</p>
            )}
          </SheetBody>
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={deleting}
        title={`Delete ${agent.data?.name ?? "agent"}?`}
        description={`This permanently deletes the agent definition "${selectedId}". Other agents and package resources are kept. Flows referencing this agent will need another profile.`}
        isPending={deleteAgent.isPending}
        onCancel={() => !deleteAgent.isPending && setDeleting(false)}
        onConfirm={() => {
          if (selectedId)
            deleteAgent.mutate(selectedId, {
              onError: () => setDeleting(false),
            });
        }}
      />
      <Dialog open={creating} onOpenChange={(open) => !create.isPending && setCreating(open)}>
        {creating && (
          <AgentEditor
            pending={create.isPending}
            error={create.error?.message}
            onSave={(id, content) => create.mutate({ id, content })}
          />
        )}
      </Dialog>
      <Dialog
        open={Boolean(editing)}
        onOpenChange={(open) => !open && !update.isPending && setEditing(undefined)}
      >
        {editing && (
          <AgentEditor
            key={editing.id}
            agent={editing}
            pending={update.isPending}
            error={update.error?.message}
            onSave={(_, content) => update.mutate({ profile: editing, content })}
          />
        )}
      </Dialog>
    </div>
  );
}
