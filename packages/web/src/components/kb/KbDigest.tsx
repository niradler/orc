import type { KbDigest, KbDigestRun, KnowledgeBase } from "@orc/core/kb";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api/client";
import { DigestDialog, RemoveDigestDialog, useAction } from "@/components/kb/KbDialogs";
import { KbSetupRow, StateDot } from "@/components/kb/KbSetupRow";
import { Button } from "@/components/ui/button";
import { useInvalidateKb, useKbDigest, useKbDigestRuns } from "@/hooks/useKnowledge";

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const NUM = /^\d+$/;
const two = (n: string) => n.padStart(2, "0");
const step = (field: string) => /^\*\/(\d+)$/.exec(field)?.[1];
const every = (n: string, unit: string) => (n === "1" ? `Every ${unit}` : `Every ${n} ${unit}s`);

/**
 * Plain words for the common cron shapes (every N minutes or hours, daily, weekdays, weekends, one
 * day a week); anything else stays as written.
 */
export function cronLabel(cron: string): string {
  const [m = "", h = "", dom, mon, dow = "", ...rest] = cron.trim().split(/\s+/);
  if (rest.length || dom !== "*" || mon !== "*") return cron;
  if (h === "*" && dow === "*") {
    if (m === "*") return "Every minute";
    const n = step(m);
    if (n) return every(n, "minute");
    if (!NUM.test(m)) return cron;
    return Number(m) ? `Every hour at :${two(m)}` : "Every hour";
  }
  if (!NUM.test(m)) return cron;
  const hours = step(h);
  if (hours && dow === "*") return `${every(hours, "hour")}${Number(m) ? ` at :${two(m)}` : ""}`;
  if (!NUM.test(h)) return cron;
  const at = `${two(h)}:${two(m)}`;
  if (dow === "*") return `Daily at ${at}`;
  if (dow === "1-5") return `Weekdays at ${at}`;
  if (dow === "0,6" || dow === "6,0") return `Weekends at ${at}`;
  if (/^[0-7]$/.test(dow)) return `${WEEKDAYS[Number(dow) % 7]}s at ${at}`;
  return cron;
}

const CRON_FIELDS = [
  { name: "minute", min: 0, max: 59, names: [] },
  { name: "hour", min: 0, max: 23, names: [] },
  { name: "day of month", min: 1, max: 31, names: [] },
  {
    name: "month",
    min: 1,
    max: 12,
    names: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"],
  },
  { name: "weekday", min: 0, max: 7, names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] },
] as const;

function cronFieldOk(field: string, spec: (typeof CRON_FIELDS)[number]): boolean {
  const value = (v: string) => {
    const named = (spec.names as readonly string[]).indexOf(v.toUpperCase());
    const n = named >= 0 ? named + (spec.min === 1 ? 1 : 0) : NUM.test(v) ? Number(v) : Number.NaN;
    return n >= spec.min && n <= spec.max ? n : Number.NaN;
  };
  return field.split(",").every((part) => {
    const match = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/i.exec(part);
    if (!match?.[1]) return false;
    if (match[2] !== undefined && Number(match[2]) < 1) return false;
    if (match[1] === "*") return true;
    const [from = "", to] = match[1].split("-");
    if (to === undefined) return !Number.isNaN(value(from));
    return value(from) <= value(to);
  });
}

/** Why a 5-field cron expression would be refused, in plain words; null when it is fine. */
export function cronProblem(cron: string): string | null {
  const fields = cron.trim().split(/\s+/).filter(Boolean);
  if (!fields.length) return "Enter a cron expression.";
  if (fields.length !== 5)
    return `A cron expression has 5 fields (minute hour day month weekday); this one has ${fields.length}.`;
  for (const [i, spec] of CRON_FIELDS.entries()) {
    const field = fields[i] ?? "";
    if (!cronFieldOk(field, spec))
      return `The ${spec.name} field "${field}" is not valid. Use a number from ${spec.min} to ${spec.max}, *, a range (1-5), a list (1,3) or a step (*/2).`;
  }
  return null;
}

/** "in 12m", "in 5h", or a weekday and time when it is more than a day away. */
export function until(ms: number): string {
  const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
  if (s < 60) return "in under a minute";
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86_400) return `in ${Math.round(s / 3600)}h`;
  const at = new Date(ms);
  return `${WEEKDAYS[at.getDay()]?.slice(0, 3)} ${two(String(at.getHours()))}:${two(String(at.getMinutes()))}`;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** Never run or paused stays neutral; only a finished run earns the success color. */
export function digestTone(digest: KbDigest): "ok" | "error" | "off" | "progress" {
  const status = digest.last_run?.status;
  if (status === "running") return "progress";
  if (digest.schedule.type === "cron" && !digest.enabled) return "off";
  if (status === "failed") return "error";
  return status === "completed" ? "ok" : "off";
}

/** "On · Daily at 03:00", "On · when you start it" or "Paused · Daily at 03:00". */
export function digestState(digest: KbDigest): string {
  const on = digest.schedule.type === "manual" || digest.enabled;
  const when =
    digest.schedule.type === "manual" ? "when you start it" : cronLabel(digest.schedule.cron);
  return `${on ? "On" : "Paused"} · ${when}`;
}

export function KbDigestSection({ kb }: { kb: KnowledgeBase }) {
  const digest = useKbDigest(kb.id);
  const [dialog, setDialog] = useState<"edit" | "remove" | null>(null);
  const [expanded, setExpanded] = useState(false);
  const d = digest.data;
  return (
    <>
      <KbSetupRow
        title="Digest"
        testId="kb-digest"
        toggleTestId="kb-digest-expand"
        expanded={expanded}
        onExpandedChange={setExpanded}
        summary={
          digest.error ? (
            <span role="alert" className="text-error">
              {(digest.error as Error).message}
            </span>
          ) : digest.isLoading ? (
            <span className="text-outline">Loading…</span>
          ) : d ? (
            <DigestSummary digest={d} />
          ) : (
            <span
              className="inline-flex items-center gap-1.5 text-outline"
              data-testid="kb-digest-off"
            >
              <StateDot tone="off" />
              Off, documents change only when someone edits them
            </span>
          )
        }
        actions={
          d ? (
            <RunNow kb={kb} digest={d} onStarted={() => setExpanded(true)} />
          ) : digest.data === null ? (
            <Button
              size="sm"
              variant="outline"
              data-testid="kb-digest-add"
              onClick={() => setDialog("edit")}
            >
              Set up
            </Button>
          ) : null
        }
      >
        {d ? (
          <DigestDetails kb={kb} digest={d} onEdit={() => setDialog("edit")} />
        ) : (
          <p className="max-w-prose text-outline">
            A digest is an agent that reads new memories, sessions and open comments, then keeps the
            documents in this knowledge base current. It can run on a schedule or only when you
            start it.
          </p>
        )}
      </KbSetupRow>
      {dialog === "edit" && (
        <DigestDialog
          kb={kb}
          digest={d ?? null}
          onClose={() => setDialog(null)}
          onRemove={() => setDialog("remove")}
        />
      )}
      {dialog === "remove" && <RemoveDigestDialog kb={kb} onClose={() => setDialog(null)} />}
    </>
  );
}

function DigestSummary({ digest }: { digest: KbDigest }) {
  const last = digest.last_run;
  const on = digest.schedule.type === "manual" || digest.enabled;
  return (
    <span
      data-testid="kb-digest-summary"
      className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5"
    >
      <StateDot tone={digestTone(digest)} />
      <span data-testid="kb-digest-enabled">{on ? "On" : "Paused"}</span>
      <span>
        ·{" "}
        {digest.schedule.type === "manual" ? (
          "runs when you start it"
        ) : (
          <span title={digest.schedule.cron}>{cronLabel(digest.schedule.cron)}</span>
        )}
      </span>
      {digest.next_run_at !== null && (
        <span className="text-outline" data-testid="kb-digest-next-run">
          ·{" "}
          <span title={new Date(digest.next_run_at).toLocaleString()}>
            next run {until(digest.next_run_at)}
          </span>
        </span>
      )}
      <span
        className="text-outline"
        data-testid="kb-digest-last-run"
        data-status={last?.status ?? "never"}
      >
        ·{" "}
        {!last ? (
          "not run yet"
        ) : last.status === "running" ? (
          "running now"
        ) : (
          <span title={new Date(last.at).toLocaleString()}>
            last run{" "}
            <span className={last.status === "failed" ? "text-error" : undefined}>
              {last.status === "completed" ? "succeeded" : last.status}
            </span>{" "}
            {ago(last.at)}
          </span>
        )}
      </span>
    </span>
  );
}

function RunNow({
  kb,
  digest,
  onStarted,
}: {
  kb: KnowledgeBase;
  digest: KbDigest;
  onStarted: () => void;
}) {
  const invalidate = useInvalidateKb();
  const action = useAction();
  const running = digest.last_run?.status === "running";
  async function runNow() {
    const res = await action.run(() => api.kb.runDigest(kb.id));
    if (!res) return;
    onStarted();
    await invalidate();
  }
  return (
    <>
      {action.error && (
        <span role="alert" className="text-error" data-testid="kb-digest-error">
          {action.error}
        </span>
      )}
      <Button
        size="sm"
        variant="outline"
        data-testid="kb-digest-run"
        onClick={runNow}
        disabled={action.pending || running}
      >
        {running ? "Running…" : "Run now"}
      </Button>
    </>
  );
}

function DigestDetails({
  kb,
  digest,
  onEdit,
}: {
  kb: KnowledgeBase;
  digest: KbDigest;
  onEdit: () => void;
}) {
  const invalidate = useInvalidateKb();
  const action = useAction();
  const runs = useKbDigestRuns(kb.id, digest);

  async function toggle() {
    const res = await action.run(() => api.kb.setDigest(kb.id, { enabled: !digest.enabled }));
    if (res) await invalidate();
  }

  return (
    <div className="min-w-0 space-y-3">
      <p className="max-w-prose text-outline">
        The <span className="font-mono text-on-surface">{digest.backend}</span> agent reads new
        memories, sessions and open comments, then updates documents here.{" "}
        <span data-testid="kb-digest-open-comments">{digest.open_comments}</span> open{" "}
        {digest.open_comments === 1 ? "comment waits" : "comments wait"} for the next run.
      </p>
      <div className="-ml-2 flex flex-wrap items-center gap-1">
        <Button size="sm" variant="ghost" data-testid="kb-digest-edit" onClick={onEdit}>
          Edit instructions and schedule
        </Button>
        {digest.schedule.type === "cron" && (
          <Button
            size="sm"
            variant="ghost"
            data-testid="kb-digest-toggle"
            onClick={toggle}
            disabled={action.pending}
          >
            {digest.enabled ? "Pause schedule" : "Resume schedule"}
          </Button>
        )}
        <Button size="sm" variant="ghost" asChild>
          <Link to={`/jobs/${encodeURIComponent(digest.job_id)}`} data-testid="kb-digest-job">
            Job history
          </Link>
        </Button>
      </div>
      {action.error && (
        <p role="alert" className="text-error" data-testid="kb-digest-error">
          {action.error}
        </p>
      )}
      <RunList runs={runs.data ?? []} />
    </div>
  );
}

const RUN_TONE: Record<string, "ok" | "error" | "progress"> = {
  failed: "error",
  success: "ok",
  running: "progress",
};

function RunList({ runs }: { runs: KbDigestRun[] }) {
  if (!runs.length) return <p className="text-outline">No runs yet.</p>;
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-medium text-outline">Recent runs</h4>
      <ol data-testid="kb-digest-runs" className="divide-y divide-outline-variant">
        {runs.map((r) => (
          <li
            key={r.run_id}
            data-testid="kb-digest-run-row"
            data-status={r.status}
            className="min-w-0 break-words py-1.5"
          >
            <span className="inline-flex items-center gap-1.5">
              <StateDot tone={RUN_TONE[r.status] ?? "off"} />
              {r.status}
            </span>
            <span className="text-outline">
              {" · "}
              {r.started_at ? (
                <span title={new Date(r.started_at).toLocaleString()}>{ago(r.started_at)}</span>
              ) : (
                "not started"
              )}
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
