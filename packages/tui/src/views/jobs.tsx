import { useKeyboard } from "@opentui/react";
import { createOrcClient } from "@orc/sdk";
import type { Job, JobRun } from "@orc/sdk/types";
import { useCallback, useState } from "react";
import { DetailPane } from "../components/detail-pane.js";
import { ResourceTable } from "../components/resource-table.js";
import { useFilter } from "../hooks/use-filter.js";
import { usePolling } from "../hooks/use-polling.js";
import { useVimList } from "../hooks/use-vim-list.js";
import { colors, statusIcon } from "../theme.js";
import type { Column, ViewMode } from "../types.js";

const client = createOrcClient();

const columns: Column<Job>[] = [
  {
    key: "enabled",
    label: " ",
    width: 3,
    render: (j) => (j.enabled ? "●" : "○"),
    color: (j) => (j.enabled ? colors.success : colors.textDim),
  },
  { key: "name", label: "Name", width: 24, render: (j) => j.name },
  {
    key: "trigger",
    label: "Trigger",
    width: 12,
    render: (j) => j.trigger_type,
    color: () => colors.textDim,
  },
  {
    key: "cron",
    label: "Schedule",
    width: 18,
    render: (j) => j.cron_expr ?? "—",
    color: () => colors.textDim,
  },
  {
    key: "runs",
    label: "Runs",
    width: 8,
    render: (j) => String(j.run_count),
  },
  {
    key: "last_run",
    label: "Last Run",
    width: 20,
    render: (j) => j.last_run_at ?? "never",
    color: () => colors.textDim,
  },
];

type Props = {
  projectId: string | null;
};

export function JobsView({ projectId }: Props) {
  const [mode, setMode] = useState<ViewMode>("list");
  const [detail, setDetail] = useState<{ job: Job; runs: JobRun[] } | null>(null);

  const { data, loading, refresh } = usePolling(
    () =>
      client.jobs.list({
        ...(projectId ? { project_id: projectId } : {}),
      }),
    5000,
  );

  const jobs = data?.jobs ?? [];

  const {
    filtered,
    query,
    active: filterActive,
  } = useFilter(jobs, (j) => `${j.name} ${j.trigger_type} ${j.description ?? ""}`, mode === "list");

  const { cursor } = useVimList(filtered.length, mode === "list" && !filterActive);

  const openDetail = useCallback(async () => {
    const job = filtered[cursor];
    if (!job) return;
    const [jobResult, runsResult] = await Promise.all([
      client.jobs.get(job.id),
      client.jobs.runs(job.id, 10),
    ]);
    if (jobResult.data) {
      setDetail({
        job: jobResult.data,
        runs: runsResult.data?.runs ?? [],
      });
      setMode("detail");
    }
  }, [filtered, cursor]);

  const triggerJob = useCallback(async () => {
    const job = filtered[cursor];
    if (!job) return;
    await client.jobs.trigger(job.id);
    refresh();
  }, [filtered, cursor, refresh]);

  useKeyboard((key) => {
    if (mode === "list" && !filterActive) {
      if (key.name === "return") openDetail();
      if (key.name === "r") refresh();
      if (key.name === "t") triggerJob();
    }
    if (mode === "detail" && key.name === "escape") {
      setMode("list");
      setDetail(null);
    }
  });

  if (mode === "detail" && detail) {
    const j = detail.job;
    const fields = [
      { label: "ID", value: j.id, color: colors.textDim },
      { label: "Name", value: j.name },
      {
        label: "Enabled",
        value: j.enabled ? "yes" : "no",
        color: j.enabled ? colors.success : colors.error,
      },
      { label: "Trigger", value: j.trigger_type },
      { label: "Schedule", value: j.cron_expr ?? "—" },
      { label: "Command", value: j.command },
      { label: "Timeout", value: `${j.timeout_secs}s` },
      { label: "Overlap", value: j.overlap },
      { label: "Notify", value: j.notify_on },
      { label: "Runs", value: String(j.run_count) },
      { label: "Last Run", value: j.last_run_at ?? "never" },
      { label: "Next Run", value: j.next_run_at ?? "—" },
    ];

    const runsText = detail.runs.length
      ? detail.runs
          .map(
            (r) =>
              `${statusIcon(r.status)} ${r.status.padEnd(10)} exit:${r.exit_code ?? "—"}  ${r.started_at ?? "—"}`,
          )
          .join("\n")
      : "No runs yet.";

    return (
      <DetailPane title={`Job: ${j.name}`} fields={fields} body={`Recent Runs:\n${runsText}`} />
    );
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" gap={2} marginBottom={0} paddingLeft={1}>
        <text fg={colors.text}>{"JOBS"}</text>
        <text fg={colors.textDim}>{loading ? "loading…" : `${filtered.length} jobs`}</text>
        {query && <text fg={colors.accent}>{`/${query}`}</text>}
      </box>
      <ResourceTable columns={columns} data={filtered} cursor={cursor} keyFn={(j) => j.id} />
    </box>
  );
}
