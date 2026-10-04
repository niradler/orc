import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
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
  const [id, setId] = useState("");
  const [content, setContent] = useState(
    "---\ndescription: Describe this specialist\n---\n\nYou are a specialist. Define your role and scope.",
  );
  const [importError, setImportError] = useState<string>();
  const [importing, setImporting] = useState(false);
  const create = useMutation({
    mutationFn: api.agents.create,
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["agents"] });
      setCreating(false);
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
          <Button data-testid="new-agent-button" onClick={() => setCreating(true)}>
            New Agent
          </Button>
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
          <p key={pkg.name} data-testid="agent-package-row" className="text-xs text-outline">
            {pkg.name}@{pkg.version} · {pkg.description}
          </p>
        ))}
        {packages.error && <p role="alert">{packages.error.message}</p>}
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
                <p className="text-xs text-outline">
                  Use this profile in a flow agent node with <code>"agent": "{agent.data.id}"</code>{" "}
                  and choose the coding backend independently.
                </p>
                <p className="text-xs text-outline">
                  Model and tool restrictions depend on backend support. ORC refuses to launch when
                  it cannot honor a declared restriction. Handoffs remain declarations; flow edges
                  choose execution.
                </p>
                <pre data-testid="agent-fields" className="text-xs whitespace-pre-wrap">
                  {JSON.stringify(agent.data.fields, null, 2)}
                </pre>
                <pre
                  data-testid="agent-content"
                  className="text-xs whitespace-pre-wrap border border-surface-highest p-4"
                >
                  {agent.data.content}
                </pre>
              </div>
            ) : (
              <p>Loading...</p>
            )}
          </SheetBody>
        </SheetContent>
      </Sheet>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New shared agent</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate({ id, content });
            }}
          >
            <Label htmlFor="agent-id">Agent filename stem</Label>
            <Input
              id="agent-id"
              data-testid="agent-id-input"
              value={id}
              onChange={(event) => setId(event.target.value)}
              placeholder="security-review"
            />
            <Label htmlFor="agent-definition">.agent.md definition</Label>
            <Textarea
              id="agent-definition"
              data-testid="agent-content-input"
              rows={15}
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
            {create.error && (
              <p role="alert" className="text-destructive">
                {create.error.message}
              </p>
            )}
            <Button
              data-testid="agent-submit"
              type="submit"
              disabled={create.isPending || !id.trim() || !content.trim()}
            >
              Create
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
