import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type AgentFull, api } from "@/api/client";
import { AgentEditor } from "@/components/AgentEditor";
import { AgentPackageEditor } from "@/components/AgentPackageEditor";
import { AgentPackageFiles } from "@/components/AgentPackageFiles";
import { CodeEditor } from "@/components/CodeEditor";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ViewHeader } from "@/components/ViewHeader";
import { useDetailRoute } from "@/hooks/useDetailRoute";
import { readPrimitiveFolder } from "@/lib/primitive-files";

export default function Agents() {
  const cache = useQueryClient();
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents.list(),
    refetchInterval: 60_000,
  });
  const packages = useQuery({
    queryKey: ["agent-packages"],
    queryFn: () => api.agentPackages.list(),
  });
  const { selectedId, openDetail, closeDetail } = useDetailRoute("/agents", "agentId");
  const agent = useQuery({
    queryKey: ["agent", selectedId],
    queryFn: () => api.agents.get(selectedId as string),
    enabled: Boolean(selectedId),
  });
  const [creating, setCreating] = useState(false);
  const [selectedPackage, setSelectedPackage] = useState<string | null>(null);
  const [editing, setEditing] = useState<AgentFull>();
  const [creatingPackage, setCreatingPackage] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [importError, setImportError] = useState<string>();
  const [importing, setImporting] = useState(false);
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
  const createPackage = useMutation({
    mutationFn: api.agentPackages.create,
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["agent-packages"] });
      void cache.invalidateQueries({ queryKey: ["agents"] });
      void cache.invalidateQueries({ queryKey: ["skills"] });
      setCreatingPackage(false);
    },
  });

  async function importPackage(files: FileList | null): Promise<void> {
    if (!files?.length) return;
    setImporting(true);
    setImportError(undefined);
    try {
      const bundle = await readPrimitiveFolder(files);
      const manifest = bundle.find((file) => file.path === "apm.yml");
      if (!manifest || manifest.encoding === "base64")
        throw new Error("Choose an APM package folder containing apm.yml");
      const name = files[0].webkitRelativePath.split("/")[0];
      await api.agentPackages.create({
        name,
        content: manifest.content,
        files: bundle.filter((file) => file !== manifest),
      });
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["agents"] }),
        cache.invalidateQueries({ queryKey: ["agent-packages"] }),
        cache.invalidateQueries({ queryKey: ["skills"] }),
      ]);
    } catch (error) {
      setImportError((error as Error).message);
    } finally {
      setImporting(false);
    }
  }

  if (agents.error)
    return <ErrorState message={agents.error.message} onRetry={() => void agents.refetch()} />;
  return (
    <div className="space-y-5">
      <ViewHeader
        title="Agents"
        meta={`${agents.data?.agents.length ?? 0} shared profiles`}
        action={
          <div className="flex gap-2">
            <Button
              data-testid="new-agent-package-button"
              variant="outline"
              onClick={() => {
                createPackage.reset();
                setCreatingPackage(true);
              }}
            >
              New APM package
            </Button>
            <Button
              data-testid="new-agent-button"
              onClick={() => {
                create.reset();
                setCreating(true);
              }}
            >
              New Agent
            </Button>
          </div>
        }
      />
      <p className="text-sm text-outline">
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
      <div className="border border-surface-highest p-4 space-y-2">
        <Label htmlFor="agent-package-folder">Import APM package folder</Label>
        <Input
          id="agent-package-folder"
          data-testid="agent-package-folder"
          type="file"
          multiple
          {...{ webkitdirectory: "" }}
          disabled={importing}
          onChange={(event) => void importPackage(event.target.files)}
        />
        {importing && <p className="text-xs">Importing...</p>}
        {importError && (
          <p role="alert" className="text-destructive">
            {importError}
          </p>
        )}
        {(packages.data?.packages ?? []).map((pkg) => (
          <button
            type="button"
            onClick={() => setSelectedPackage(pkg.name)}
            key={pkg.name}
            data-testid="agent-package-row"
            data-package-name={pkg.name}
            className="text-xs text-outline"
          >
            {pkg.name}@{pkg.version} · {pkg.description}
          </button>
        ))}
        {packages.error && <p role="alert">{packages.error.message}</p>}
        {selectedPackage && (
          <AgentPackageFiles
            key={selectedPackage}
            name={selectedPackage}
            onClose={() => setSelectedPackage(null)}
          />
        )}
      </div>
      {[...(agents.data?.broken ?? []), ...(packages.data?.broken ?? [])].map((issue) => (
        <p key={issue.path} role="alert" className="text-destructive">
          {issue.path}: {issue.error}
        </p>
      ))}
      <div className="space-y-2">
        {agents.isLoading && <p>Loading agents...</p>}
        {agents.data?.agents.map((profile) => (
          <button
            key={profile.id}
            type="button"
            data-testid="agent-row"
            data-agent-id={profile.id}
            onClick={() => openDetail(profile.id)}
            className="w-full text-left border border-surface-highest rounded-sm p-4 hover:bg-surface-low"
          >
            <span className="text-sm font-medium">{profile.name}</span>
            <span className="ml-3 text-xs text-outline">
              {profile.id} · {profile.source}
            </span>
            <p className="text-xs text-outline mt-1">{profile.description}</p>
          </button>
        ))}
        {!agents.isLoading && agents.data?.agents.length === 0 && (
          <p className="text-sm text-outline">
            Create an agent or import an APM package to share specialists.
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
                <p className="text-xs text-outline">
                  Use this profile in a flow agent node with <code>"agent": "{agent.data.id}"</code>{" "}
                  and choose the coding backend independently.
                </p>
                <p className="text-xs text-outline">
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
          if (selectedId) deleteAgent.mutate(selectedId, { onError: () => setDeleting(false) });
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
      <Dialog
        open={creatingPackage}
        onOpenChange={(open) => !createPackage.isPending && setCreatingPackage(open)}
      >
        {creatingPackage && (
          <AgentPackageEditor
            pending={createPackage.isPending}
            error={createPackage.error?.message}
            onSave={(input) => createPackage.mutate(input)}
          />
        )}
      </Dialog>
    </div>
  );
}
