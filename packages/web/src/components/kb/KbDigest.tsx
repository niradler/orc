import type { KbDigest, KbDigestRun, KnowledgeBase } from "@orc/core/kb";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api/client";
import { DigestDialog, RemoveDigestDialog, useAction } from "@/components/kb/KbDialogs";
import { Button } from "@/components/ui/button";
import { useInvalidateKb, useKbDigest, useKbDigestRuns } from "@/hooks/useKnowledge";

/** job_runs timestamps are unix seconds; digest and comment timestamps are milliseconds. */
const runTime = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : "—");

function scheduleLabel(digest: KbDigest): string {
  return digest.schedule.type === "cron" ? `cron ${digest.schedule.cron}` : "manual only";
}

export function KbDigestSection({ kb }: { kb: KnowledgeBase }) {
  const digest = useKbDigest(kb.id);
  const [dialog, setDialog] = useState<"edit" | "remove" | null>(null);
  const d = digest.data;
  return (
    <section data-testid="kb-digest" aria-labelledby="kb-digest-heading" className="space-y-2">
      <h3 id="kb-digest-heading" className="font-medium">
        Digest
      </h3>
      {digest.error ? (
        <p role="alert" className="text-sm text-error">
          {(digest.error as Error).message}
        </p>
      ) : digest.isLoading ? (
        <p className="text-sm text-outline">Loading…</p>
      ) : d ? (
        <DigestStatus
          kb={kb}
          digest={d}
          onEdit={() => setDialog("edit")}
          onRemove={() => setDialog("remove")}
        />
      ) : (
        <div className="space-y-2 text-sm">
          <p className="text-outline">
            An agent reads new memories, sessions and comments and keeps this knowledge base
            current.
          </p>
          <Button variant="outline" data-testid="kb-digest-add" onClick={() => setDialog("edit")}>
            Add digest
          </Button>
        </div>
      )}
      {dialog === "edit" && (
        <DigestDialog kb={kb} digest={d ?? null} onClose={() => setDialog(null)} />
      )}
      {dialog === "remove" && <RemoveDigestDialog kb={kb} onClose={() => setDialog(null)} />}
    </section>
  );
}

function DigestStatus({
  kb,
  digest,
  onEdit,
  onRemove,
}: {
  kb: KnowledgeBase;
  digest: KbDigest;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const invalidate = useInvalidateKb();
  const action = useAction();
  const runs = useKbDigestRuns(kb.id, true);
  const [started, setStarted] = useState(false);
  const last = digest.last_run;

  async function runNow() {
    setStarted(false);
    const res = await action.run(() => api.kb.runDigest(kb.id));
    if (!res) return;
    setStarted(true);
    await invalidate();
  }
  async function toggle() {
    const res = await action.run(() => api.kb.setDigest(kb.id, { enabled: !digest.enabled }));
    if (res) await invalidate();
  }

  return (
    <div className="min-w-0 space-y-3 text-sm">
      <p data-testid="kb-digest-summary" className="break-words text-outline">
        <span className="font-mono">{digest.backend}</span> · {scheduleLabel(digest)} ·{" "}
        <span data-testid="kb-digest-enabled">{digest.enabled ? "enabled" : "disabled"}</span>
      </p>
      <p data-testid="kb-digest-last-run" data-status={last?.status ?? "never"}>
        {last ? (
          <>
            Last run {last.status} · {new Date(last.at).toLocaleString()}
            {last.note && <span className="block break-words text-outline">{last.note}</span>}
          </>
        ) : (
          <span className="text-outline">Not run yet</span>
        )}
      </p>
      <p className="text-outline">
        <span data-testid="kb-digest-open-comments">{digest.open_comments}</span> open{" "}
        {digest.open_comments === 1 ? "comment" : "comments"} ·{" "}
        <Link
          to={`/jobs/${encodeURIComponent(digest.job_id)}`}
          className="text-primary hover:underline"
          data-testid="kb-digest-job"
        >
          Job
        </Link>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          data-testid="kb-digest-run"
          onClick={runNow}
          disabled={action.pending || last?.status === "running"}
        >
          Run now
        </Button>
        <Button size="sm" variant="ghost" data-testid="kb-digest-edit" onClick={onEdit}>
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="kb-digest-toggle"
          onClick={toggle}
          disabled={action.pending}
        >
          {digest.enabled ? "Disable" : "Enable"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-error"
          data-testid="kb-digest-remove"
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
      {started && (
        <p role="status" className="text-outline" data-testid="kb-digest-run-started">
          Run started.
        </p>
      )}
      {action.error && (
        <p role="alert" className="text-error" data-testid="kb-digest-error">
          {action.error}
        </p>
      )}
      <RunList runs={runs.data ?? []} />
    </div>
  );
}

function RunList({ runs }: { runs: KbDigestRun[] }) {
  if (!runs.length) return null;
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-medium text-outline">Recent runs</h4>
      <ol data-testid="kb-digest-runs" className="space-y-1">
        {runs.map((r) => (
          <li
            key={r.run_id}
            data-testid="kb-digest-run-row"
            data-status={r.status}
            className="min-w-0 break-words"
          >
            <span className={r.status === "failed" ? "text-error" : undefined}>{r.status}</span>
            <span className="text-outline">
              {" "}
              · {runTime(r.started_at)}
              {r.trigger_by ? ` · ${r.trigger_by}` : ""}
            </span>
            {r.session_id && (
              <Link
                to={`/audit/${encodeURIComponent(r.session_id)}`}
                className="ml-2 text-primary hover:underline"
              >
                Session
              </Link>
            )}
            {(r.error || r.summary) && (
              <span
                className="block truncate text-xs text-outline"
                title={r.error ?? r.summary ?? ""}
              >
                {r.error ?? r.summary}
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
