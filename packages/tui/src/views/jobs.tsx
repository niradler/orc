import { createOrcClient } from "@orc/sdk";
import type { Job, JobRun } from "@orc/sdk/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { DetailPane } from "../components/detail-pane.js";
import { EditFormOverlay, type FormField, useEditForm } from "../components/edit-form.js";
import { ResourceTable } from "../components/resource-table.js";
import { useFilter } from "../hooks/use-filter.js";
import { usePolling } from "../hooks/use-polling.js";
import { useVimList } from "../hooks/use-vim-list.js";
import { colors, statusIcon } from "../theme.js";
import type { Column, KeyEvent, ViewKeyHandler, ViewMode } from "../types.js";

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
  { key: "runs", label: "Runs", width: 8, render: (j) => String(j.run_count) },
  {
    key: "last_run",
    label: "Last Run",
    width: 20,
    render: (j) => j.last_run_at ?? "never",
    color: () => colors.textDim,
  },
];

function jobFields(): FormField[] {
  return [
    { key: "name", label: "Name", value: "" },
    { key: "command", label: "Command", value: "" },
    {
      key: "trigger_type",
      label: "Trigger",
      value: "manual",
      options: ["manual", "cron", "watch", "one-shot", "webhook", "bridge-msg"],
    },
    { key: "cron_expr", label: "Cron Expr", value: "" },
    { key: "description", label: "Description", value: "" },
  ];
}

type Props = { projectId: string | null; onRegisterKeyHandler: (handler: ViewKeyHandler) => void };

export function JobsView({ projectId, onRegisterKeyHandler }: Props) {
  const [mode, setMode] = useState<ViewMode>("list");
  const [detail, setDetail] = useState<{ job: Job; runs: JobRun[] } | null>(null);
  const editForm = useEditForm();

  const { data, loading, refresh } = usePolling(
    () => client.jobs.list({ ...(projectId ? { project_id: projectId } : {}) }),
    5000,
  );
  const jobs = data?.jobs ?? [];
  const {
    filtered,
    query,
    active: filterActive,
    handleKey: filterHandleKey,
  } = useFilter(jobs, (j) => `${j.name} ${j.trigger_type} ${j.description ?? ""}`, mode === "list");
  const { cursor, handleKey: vimHandleKey } = useVimList(
    filtered.length,
    mode === "list" && !filterActive,
  );

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const filterActiveRef = useRef(filterActive);
  filterActiveRef.current = filterActive;
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const editFormRef = useRef(editForm);
  editFormRef.current = editForm;

  const submitCreate = useCallback(
    async (vals: Record<string, string>) => {
      if (!vals.name || !vals.command) return;
      await client.jobs.create({
        name: vals.name,
        command: vals.command,
        trigger_type: (vals.trigger_type as Job["trigger_type"]) || "manual",
        ...(vals.cron_expr ? { cron_expr: vals.cron_expr } : {}),
        ...(vals.description ? { description: vals.description } : {}),
        ...(projectId ? { project_id: projectId } : {}),
      });
      setMode("list");
      refreshRef.current();
    },
    [projectId],
  );

  const submitCreateRef = useRef(submitCreate);
  submitCreateRef.current = submitCreate;

  const handleKey = useCallback(
    (key: KeyEvent): boolean => {
      if (modeRef.current === "create") {
        editFormRef.current.handleKey(key, submitCreateRef.current);
        if (!editFormRef.current.active) setMode("list");
        return true;
      }
      if (filterHandleKey(key)) return true;
      if (modeRef.current === "list" && !filterActiveRef.current) {
        if (vimHandleKey(key)) return true;
        if (key.name === "return") {
          const job = filteredRef.current[cursorRef.current];
          if (job)
            Promise.all([client.jobs.get(job.id), client.jobs.runs(job.id, 10)]).then(
              ([jr, rr]) => {
                if (jr.data) {
                  setDetail({ job: jr.data, runs: rr.data?.runs ?? [] });
                  setMode("detail");
                }
              },
            );
          return true;
        }
        if (key.name === "r") {
          refreshRef.current();
          return true;
        }
        if (key.name === "t") {
          const job = filteredRef.current[cursorRef.current];
          if (job) client.jobs.trigger(job.id).then(() => refreshRef.current());
          return true;
        }
        if (key.name === "n") {
          editFormRef.current.open(jobFields());
          setMode("create");
          return true;
        }
      }
      if (modeRef.current === "detail" && key.name === "escape") {
        setMode("list");
        setDetail(null);
        return true;
      }
      return false;
    },
    [filterHandleKey, vimHandleKey],
  );

  useEffect(() => {
    onRegisterKeyHandler(handleKey);
  }, [handleKey, onRegisterKeyHandler]);

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
      <EditFormOverlay
        title="New Job"
        fields={editForm.fields}
        focusIdx={editForm.focusIdx}
        editing={editForm.editing}
        active={mode === "create"}
      />
    </box>
  );
}
