import type { ArchiveSession } from "@orc/core/session-archive";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useProjects } from "@/hooks/useProjects";

export function ArchivedSessions({ projectId }: { projectId: string }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const projects = useProjects();
  const [pagination, setPagination] = useState({ key: "", offset: 0 });
  const [selected, setSelected] = useState<ArchiveSession | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [project, setProject] = useState(projectId);
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("");
  const [commit, setCommit] = useState("");
  const [subdirectory, setSubdirectory] = useState("");
  const [turnOffset, setTurnOffset] = useState(0);
  const q = params.get("q") ?? "";
  const agent = params.get("agent") ?? "";
  const visible = params.get("ended") !== "0";
  const paginationKey = JSON.stringify([projectId, q, agent]);
  const offset = pagination.key === paginationKey ? pagination.offset : 0;
  const setOffset = (offset: number) => setPagination({ key: paginationKey, offset });
  const listing = useQuery({
    queryKey: ["sessions", "archive", projectId, q, agent, offset],
    queryFn: () =>
      api.sessions.archive({
        q,
        ...(projectId === "all" ? {} : { project_id: projectId }),
        ...(["claude", "codex"].includes(agent) ? { agent } : {}),
        offset,
        limit: 20,
      }),
    enabled: visible,
    refetchInterval: 10000,
  });
  const transcript = useQuery({
    queryKey: ["sessions", "archive-transcript", selected?.id, selected?.revision, turnOffset],
    queryFn: () =>
      api.sessions.archiveTranscript(selected?.id as string, {
        revision: selected?.revision,
        offset: turnOffset,
        limit: 50,
      }),
    enabled: !!selected,
  });

  async function run(action: () => Promise<void>) {
    setPending(true);
    setError("");
    setFeedback("");
    try {
      await action();
      await qc.invalidateQueries({ queryKey: ["sessions"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
    } finally {
      setPending(false);
    }
  }

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    const name = projects.data?.find((p) => p.id === project)?.name;
    if (!name) {
      setError("Select a project before uploading");
      return;
    }
    await run(async () => {
      let source = localStorage.getItem("orc_session_upload_source");
      if (!source) {
        source = crypto.randomUUID();
        localStorage.setItem("orc_session_upload_source", source);
      }
      let accepted = 0;
      const failures: string[] = [];
      for (const file of Array.from(files)) {
        try {
          if (file.size > 60 * 1024 * 1024) throw new Error("File exceeds 60 MiB");
          const content = await file.text();
          const records = content
            .split(/\r?\n/)
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line));
          const codex = records[0]?.type === "session_meta";
          const native = codex ? records[0].payload : records.find((r) => r.sessionId);
          const result = await api.sessions.archiveUpload({
            project: name,
            source_id: source,
            agent: codex ? "codex" : "claude",
            session_id: codex ? native?.id : native?.sessionId,
            title: file.name.slice(0, 200),
            metadata: {
              cwd: native?.cwd ?? "",
              subdirectory: "",
              ...(codex && native?.git?.repository_url
                ? { repository: native.git.repository_url }
                : {}),
              ...(codex && native?.git?.branch ? { branch: native.git.branch } : {}),
              ...(codex && native?.git?.commit_hash ? { commit: native.git.commit_hash } : {}),
            },
            bundle: { version: 1, files: [{ path: "session.jsonl", content }] },
          });
          if (["created", "updated", "unchanged", "stale"].includes(result.outcome)) accepted++;
        } catch (cause) {
          failures.push(
            `${file.name}: ${cause instanceof Error ? cause.message : "Upload failed"}`,
          );
        }
      }
      setFeedback(
        `${accepted} of ${files.length} sessions synchronized${failures.length ? `; ${failures.length} need attention` : ""}.`,
      );
      if (failures.length) setError(failures.join("\n"));
    });
  }

  if (!visible) return null;
  return (
    <section className="mt-8 space-y-3" data-testid="session-archive">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-medium">Archived sessions</h2>
          <p className="text-xs text-outline">
            Uploaded history stays available after the source computer is offline.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            data-testid="archive-index"
            disabled={pending}
            onClick={() =>
              void run(async () => {
                const result = await api.sessions.archiveIndex(
                  projectId === "all" || projectId === "unassigned" ? undefined : projectId,
                );
                setFeedback(
                  `${result.indexed} sessions indexed; ${result.failed} failed; ${result.skipped} skipped.`,
                );
              })
            }
          >
            Index discovered sessions
          </Button>
          <Button
            data-testid="archive-upload-open"
            onClick={() => {
              setProject(projectId);
              setUploading(true);
            }}
          >
            Upload sessions
          </Button>
        </div>
      </div>
      {feedback && (
        <p role="status" data-testid="archive-feedback" className="text-sm">
          {feedback}
        </p>
      )}
      {(error || listing.error) && (
        <p role="alert" className="whitespace-pre-wrap text-sm text-error">
          {error || listing.error?.message}
        </p>
      )}
      {listing.data?.degraded && (
        <p role="status" data-testid="archive-degraded" className="text-xs text-outline">
          {listing.data.degraded}
        </p>
      )}
      {!!listing.data?.pending_chunks && (
        <p className="text-xs text-outline">
          {listing.data.pending_chunks} passages waiting for embeddings
        </p>
      )}
      <div className="divide-y divide-outline-variant rounded border border-outline-variant">
        {listing.isLoading && <p className="p-4 text-sm">Loading archived sessions…</p>}
        {!listing.isLoading && !listing.data?.sessions.length && (
          <p className="p-4 text-sm text-outline">No archived sessions match this view.</p>
        )}
        {listing.data?.sessions.map((session) => (
          <button
            type="button"
            key={session.id}
            data-testid="archive-session-row"
            data-archive-id={session.id}
            className="block w-full p-3 text-left hover:bg-surface-container"
            onClick={() => {
              setSelected(session);
              setTurnOffset(0);
              setRepository(session.metadata.repository ?? "");
              setBranch(session.metadata.branch ?? "");
              setCommit(session.metadata.commit ?? "");
              setSubdirectory(session.metadata.subdirectory);
            }}
          >
            <span className="block text-sm font-medium">{session.title}</span>
            <span className="text-xs text-outline">
              {session.agent} · ended · {new Date(session.updated_at).toLocaleString()} · revision{" "}
              {session.revision} · {session.metadata.cwd}
            </span>
            {session.passages.map((passage) => (
              <span className="mt-1 block text-sm text-outline" key={passage.citation}>
                {passage.snippet}
              </span>
            ))}
            {session.embedding_error && (
              <span className="block text-xs text-error">{session.embedding_error}</span>
            )}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          Previous
        </Button>
        <Button
          variant="ghost"
          disabled={!listing.data?.has_more}
          onClick={() => setOffset(offset + 20)}
        >
          Next
        </Button>
      </div>
      <Dialog open={uploading} onOpenChange={setUploading}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload session histories</DialogTitle>
            <DialogDescription>
              Select an existing project and native Claude/Codex JSONL files. This stores history
              without starting a terminal. For large collections, use the orc-platform sync script.
            </DialogDescription>
          </DialogHeader>
          <Label htmlFor="archive-project">Project</Label>
          <select
            id="archive-project"
            data-testid="archive-project"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            className="rounded border border-outline-variant bg-surface p-2"
          >
            <option value="all">Select a project</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Input
            data-testid="archive-files"
            type="file"
            multiple
            accept=".jsonl"
            disabled={pending || !projects.data?.some((p) => p.id === project)}
            onChange={(e) => void upload(e.target.files)}
          />
          {pending && <p role="status">Uploading…</p>}
          {feedback && (
            <p role="status" data-testid="archive-upload-feedback">
              {feedback}
            </p>
          )}
          {error && (
            <p role="alert" className="whitespace-pre-wrap text-sm text-error">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent
          className="max-h-[90vh] max-w-3xl overflow-y-auto"
          data-testid="archive-detail"
        >
          <DialogHeader>
            <DialogTitle>{selected?.title}</DialogTitle>
            <DialogDescription>
              Archived history · revision {selected?.revision}. Prepare a destination checkout to
              continue in a terminal.
            </DialogDescription>
          </DialogHeader>
          {transcript.error && <p role="alert">{transcript.error.message}</p>}
          {transcript.data?.turns.map((turn) => (
            <div
              key={turn.index}
              className="border-b border-outline-variant py-2"
              data-testid="archive-turn"
            >
              <p className="text-xs text-outline">{turn.role}</p>
              <pre className="whitespace-pre-wrap break-words text-sm">
                {turn.blocks
                  .map((block) =>
                    block.type === "tool_use"
                      ? `${block.name}\n${block.input}\n${block.result ?? ""}`
                      : block.text,
                  )
                  .join("\n")}
              </pre>
            </div>
          ))}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              disabled={!turnOffset}
              onClick={() => setTurnOffset(Math.max(0, turnOffset - 50))}
            >
              Previous messages
            </Button>
            <Button
              variant="ghost"
              disabled={turnOffset + 50 >= (transcript.data?.total ?? 0)}
              onClick={() => setTurnOffset(turnOffset + 50)}
            >
              Next messages
            </Button>
          </div>
          <div className="space-y-2 border-t border-outline-variant pt-3">
            <h3 className="text-sm font-medium">Continue on ORC</h3>
            <p className="text-xs text-outline">
              Use the pushed repository, branch and exact commit for the work you want to continue.
              The destination project must have its repository configured.
            </p>
            <Label htmlFor="archive-repository">Repository</Label>
            <Input
              id="archive-repository"
              data-testid="archive-repository"
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
            />
            <Label htmlFor="archive-branch">Branch</Label>
            <Input
              id="archive-branch"
              data-testid="archive-branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            />
            <Label htmlFor="archive-commit">Pushed commit</Label>
            <Input
              id="archive-commit"
              data-testid="archive-commit"
              value={commit}
              onChange={(e) => setCommit(e.target.value)}
            />
            <Label htmlFor="archive-subdirectory">Repository subdirectory</Label>
            <Input
              id="archive-subdirectory"
              data-testid="archive-subdirectory"
              value={subdirectory}
              onChange={(e) => setSubdirectory(e.target.value)}
              placeholder="Repository root"
            />
            <Button
              data-testid="archive-resume"
              disabled={pending || !repository || !branch || !/^[a-f0-9]{40}$/i.test(commit)}
              onClick={() =>
                void run(async () => {
                  if (!selected) return;
                  const ready = await api.sessions.archiveResume(selected.id, {
                    revision: selected.revision,
                    repository,
                    branch,
                    commit,
                    subdirectory,
                  });
                  if (ready.status !== "ready" || !ready.live_session_id)
                    throw new Error(ready.error || "Session preparation failed");
                  const terminal = await api.terminals.create({
                    kind: selected.agent,
                    live_session_id: ready.live_session_id,
                  });
                  navigate(`/terminals/${terminal.id}`);
                })
              }
            >
              {pending ? "Preparing…" : "Prepare and resume in terminal"}
            </Button>
            {error && (
              <p role="alert" className="text-sm text-error">
                {error}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
