import { createOrcClient } from "@orc/sdk";
import type { Job, JobRun } from "@orc/sdk/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { expectApiData } from "../api-result.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { DetailPane } from "../components/detail-pane.js";
import {
  EditFormOverlay,
  type FormField,
  formErrorMessage,
  isSaveKey,
  useEditForm,
} from "../components/edit-form.js";
import { ResourceTable } from "../components/resource-table.js";
import { ViewToolbar } from "../components/view-toolbar.js";
import { useFilter } from "../hooks/use-filter.js";
import { usePolling } from "../hooks/use-polling.js";
import { useVimList } from "../hooks/use-vim-list.js";
import { colors, statusIcon } from "../theme.js";
import type { Column, KeyEvent, SelectOption, ViewKeyHandler, ViewState } from "../types.js";

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

function jobFields(job?: Job): FormField[] {
  const triggerOptions: SelectOption[] = [
    { label: "Manual", value: "manual" },
    { label: "Cron", value: "cron" },
    { label: "Watch", value: "watch" },
    { label: "One-shot", value: "one-shot" },
    { label: "Webhook", value: "webhook" },
    { label: "Bridge message", value: "bridge-msg" },
  ];
  const enabledOptions: SelectOption[] = [
    { label: "Enabled", value: "yes" },
    { label: "Disabled", value: "no" },
  ];
  return [
    { key: "name", label: "Name", value: job?.name ?? "", placeholder: "nightly-index" },
    {
      key: "command",
      label: "Command",
      value: job?.command ?? "",
      type: "textarea",
      height: 5,
      placeholder: "bun run sync:index",
    },
    {
      key: "trigger_type",
      label: "Trigger",
      value: job?.trigger_type ?? "manual",
      type: "select",
      options: triggerOptions,
    },
    {
      key: "cron_expr",
      label: "Cron Expr",
      value: job?.cron_expr ?? "",
      placeholder: "0 */6 * * * *",
    },
    {
      key: "description",
      label: "Description",
      value: job?.description ?? "",
      type: "textarea",
      height: 4,
      placeholder: "What this job does",
    },
    {
      key: "enabled",
      label: "Enabled",
      value: job?.enabled === false ? "no" : "yes",
      type: "select",
      options: enabledOptions,
    },
  ];
}

type Props = {
  projectId: string | null;
  onRegisterKeyHandler: (handler: ViewKeyHandler) => void;
  onStateChange: (state: ViewState) => void;
};

export function JobsView({ projectId, onRegisterKeyHandler, onStateChange }: Props) {
  const [mode, setMode] = useState<"browse" | "detail" | "form" | "confirm">("browse");
  const [detail, setDetail] = useState<{ job: Job; runs: JobRun[] } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Job | null>(null);
  const [formIntent, setFormIntent] = useState<"create" | "edit">("create");
  const [formTarget, setFormTarget] = useState<Job | null>(null);
  const editForm = useEditForm();

  const { data, loading, error, refresh } = usePolling(
    () => client.jobs.list({ ...(projectId ? { project_id: projectId } : {}) }),
    5000,
  );
  const jobs = data?.jobs ?? [];
  const {
    filtered,
    query,
    active: filterActive,
    setQuery,
    setActive: setFilterActive,
  } = useFilter(jobs, (j) => `${j.name} ${j.trigger_type} ${j.description ?? ""}`, true);
  const { cursor, handleKey: vimHandleKey } = useVimList(
    filtered.length,
    mode === "browse" && !filterActive,
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
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const deleteTargetRef = useRef(deleteTarget);
  deleteTargetRef.current = deleteTarget;
  const formIntentRef = useRef(formIntent);
  formIntentRef.current = formIntent;
  const formTargetRef = useRef(formTarget);
  formTargetRef.current = formTarget;

  useEffect(() => {
    const selectedJob = filtered[cursor];
    onStateChange({
      mode: filterActive ? "filter" : mode,
      title: "Jobs",
      countLabel: loading ? "Loading jobs…" : `${filtered.length} visible jobs`,
      filterQuery: query,
      filterActive,
      navigationLocked: filterActive || mode !== "browse",
      selectionLabel:
        mode === "detail" && detail
          ? `Job detail • ${detail.job.name}`
          : selectedJob
            ? `${selectedJob.name} • ${selectedJob.trigger_type} • runs ${selectedJob.run_count}`
            : "No job selected yet.",
      detailId: mode === "detail" ? (detail?.job.id ?? null) : null,
      statusMessage:
        mode === "detail"
          ? "Detail actions: e edit • d delete • t trigger"
          : "Enter opens detail • n creates",
    });
  }, [mode, query, filterActive, onStateChange, filtered, cursor, detail, loading]);

  const doCreate = useCallback(
    async (vals: Record<string, string>) => {
      if (!vals.name) throw new Error("Job name is required.");
      if (!vals.command) throw new Error("Command is required.");
      const created = await client.jobs.create({
        name: vals.name,
        command: vals.command,
        trigger_type: (vals.trigger_type as Job["trigger_type"]) || "manual",
        ...(vals.cron_expr ? { cron_expr: vals.cron_expr } : {}),
        ...(vals.description ? { description: vals.description } : {}),
        ...(projectId ? { project_id: projectId } : {}),
      });
      return expectApiData(created, "Couldn't create job.");
    },
    [projectId],
  );

  const doCreateRef = useRef(doCreate);
  doCreateRef.current = doCreate;
  const doEdit = useCallback(async (vals: Record<string, string>) => {
    const job = formTargetRef.current ?? detailRef.current?.job;
    if (!job) throw new Error("Select a job first.");
    const updated = await client.jobs.update(job.id, {
      ...(vals.name ? { name: vals.name } : {}),
      ...(vals.command ? { command: vals.command } : {}),
      ...(vals.trigger_type ? { trigger_type: vals.trigger_type as Job["trigger_type"] } : {}),
      ...(vals.cron_expr ? { cron_expr: vals.cron_expr } : {}),
      ...(vals.description ? { description: vals.description } : {}),
      enabled: vals.enabled === "yes",
    });
    return expectApiData(updated, "Couldn't save job.");
  }, []);
  const doEditRef = useRef(doEdit);
  doEditRef.current = doEdit;

  const submitCurrentForm = useCallback(async () => {
    const result = editFormRef.current.submit();
    const creating = formIntentRef.current === "create";
    const action = creating ? doCreateRef.current : doEditRef.current;

    if (!editFormRef.current.beginSubmit(creating ? "Creating job…" : "Saving job…")) return;

    try {
      const savedJob = await action(result.values);
      if (savedJob && detailRef.current) {
        setDetail((current) =>
          current
            ? {
                ...current,
                job: savedJob,
              }
            : current,
        );
      }
      await refreshRef.current();
      editFormRef.current.finishSubmit("success", creating ? "Job created." : "Job saved.");
      setTimeout(() => {
        editFormRef.current.close();
        setFormTarget(null);
        setMode("browse");
      }, 700);
    } catch (error) {
      editFormRef.current.finishSubmit("error", formErrorMessage(error, "Couldn't save job."));
    }
  }, []);

  const handleKey = useCallback(
    (key: KeyEvent): boolean => {
      if (filterActiveRef.current) {
        if (key.name === "escape" || key.name === "return") {
          setFilterActive(false);
        }
        return true;
      }
      if (modeRef.current === "form") {
        if (key.name === "escape") {
          if (editFormRef.current.submitState.status === "saving") return true;
          editFormRef.current.close();
          setMode("browse");
          setFormTarget(null);
          return true;
        }
        if (isSaveKey(key)) {
          void submitCurrentForm();
          return true;
        }
        if (key.name === "tab" && key.shift) {
          editFormRef.current.prevField();
          return true;
        }
        if (key.name === "tab") {
          editFormRef.current.nextField();
          return true;
        }
        return true;
      }
      if (modeRef.current === "confirm") {
        if (key.name === "y" || key.name === "return") {
          const job = deleteTargetRef.current;
          if (job) client.jobs.delete(job.id).then(() => refreshRef.current());
          setDeleteTarget(null);
          setMode("browse");
          return true;
        }
        if (key.name === "n" || key.name === "escape") {
          setDeleteTarget(null);
          setMode("browse");
          return true;
        }
        return true;
      }
      if (modeRef.current === "browse" && !filterActiveRef.current) {
        if (vimHandleKey(key)) return true;
        if (key.name === "/" || key.name === "f") {
          setFilterActive(true);
          return true;
        }
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
        if (key.name === "n") {
          setFormIntent("create");
          setFormTarget(null);
          editFormRef.current.open(jobFields());
          setMode("form");
          return true;
        }
      }
      if (modeRef.current === "detail") {
        if (key.name === "escape") {
          setMode("browse");
          setDetail(null);
          return true;
        }
        if (key.name === "t" && detailRef.current) {
          client.jobs.trigger(detailRef.current.job.id).then(() => refreshRef.current());
          return true;
        }
        if (key.name === "e" && detailRef.current) {
          setFormIntent("edit");
          setFormTarget(detailRef.current.job);
          editFormRef.current.open(jobFields(detailRef.current.job));
          setMode("form");
          return true;
        }
        if (key.name === "d" && detailRef.current) {
          setDeleteTarget(detailRef.current.job);
          setMode("confirm");
          return true;
        }
        return false;
      }
      return false;
    },
    [submitCurrentForm, vimHandleKey, setFilterActive],
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
      <DetailPane
        title={`Job: ${j.name}`}
        fields={fields}
        body={`Recent Runs:\n${runsText}`}
        hint="Esc back • e edit • d delete • t trigger • Up/Down scroll"
      />
    );
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <ViewToolbar
        title="Jobs"
        countLabel={loading ? "Loading jobs…" : `${filtered.length} visible jobs`}
        filterQuery={query}
        filterActive={filterActive}
        filterPlaceholder="Search name, trigger, schedule, or description"
        onFilterChange={setQuery}
        onFilterSubmit={() => setFilterActive(false)}
        statusMessage={projectId ? "Project-scoped view" : "All jobs"}
      />
      <ResourceTable
        columns={columns}
        data={filtered}
        cursor={cursor}
        keyFn={(j) => j.id}
        loading={loading}
        error={error}
        emptyMessage="No jobs configured yet."
        filteredEmptyMessage="No jobs match the current search."
        hasActiveFilter={Boolean(query)}
        selectedSummary={
          filtered[cursor]
            ? `${filtered[cursor]?.trigger_type} • ${filtered[cursor]?.run_count} runs • ${filtered[cursor]?.name}`
            : "Create a job with n or trigger one with t."
        }
      />
      <EditFormOverlay
        title={formIntent === "create" ? "New Job" : "Edit Job"}
        fields={editForm.fields}
        focusIdx={editForm.focusIdx}
        active={mode === "form"}
        onChange={editForm.updateValue}
        submitState={editForm.submitState}
        onSubmit={submitCurrentForm}
        onCancel={() => {
          if (editForm.submitState.status === "saving") return;
          editForm.close();
          setMode("browse");
          setFormTarget(null);
        }}
        onNextField={editForm.nextField}
        onPrevField={editForm.prevField}
      />
      <ConfirmDialog
        message={deleteTarget ? `Delete job "${deleteTarget.name}"?` : ""}
        active={mode === "confirm"}
      />
    </box>
  );
}
