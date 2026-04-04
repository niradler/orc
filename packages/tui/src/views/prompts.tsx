import { createOrcClient } from "@orc/sdk";
import type { Prompt } from "@orc/sdk/types";
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
import {
  handleDetailEscapeKey,
  handleFilterInputKey,
  isFilterToggleKey,
  isOpenDetailKey,
  isRefreshKey,
} from "../navigation.js";
import { colors } from "../theme.js";
import type { Column, KeyEvent, SelectOption, ViewKeyHandler, ViewState } from "../types.js";

const client = createOrcClient();

const columns: Column<Prompt>[] = [
  {
    key: "skill",
    label: " ",
    width: 3,
    minWidth: 2,
    priority: 6,
    render: (p) => (p.is_skill ? "⚡" : " "),
    color: () => colors.warning,
  },
  { key: "name", label: "Name", width: 24, minWidth: 14, priority: 7, render: (p) => p.name },
  {
    key: "desc",
    label: "Description",
    width: 40,
    minWidth: 16,
    priority: 5,
    render: (p) => {
      const t = p.description ?? "—";
      return t.length > 38 ? `${t.slice(0, 38)}…` : t;
    },
    color: () => colors.textDim,
  },
  {
    key: "version",
    label: "Ver",
    width: 6,
    minWidth: 4,
    priority: 4,
    render: (p) => `v${p.version}`,
  },
  {
    key: "pinned",
    label: "Pin",
    width: 5,
    minWidth: 3,
    priority: 2,
    render: (p) => (p.pinned ? "📌" : ""),
  },
  {
    key: "tags",
    label: "Tags",
    width: 20,
    minWidth: 10,
    priority: 1,
    render: (p) => (p.tags?.length ? p.tags.join(", ") : "—"),
    color: () => colors.textDim,
  },
];

function promptFields(p?: Prompt): FormField[] {
  const skillOptions: SelectOption[] = [
    { label: "No", value: "no" },
    { label: "Yes", value: "yes" },
  ];
  return [
    { key: "name", label: "Name", value: p?.name ?? "", placeholder: "prompt-name" },
    {
      key: "description",
      label: "Description",
      value: p?.description ?? "",
      type: "textarea",
      height: 4,
      placeholder: "Short description for search and discovery",
    },
    {
      key: "template",
      label: "Template",
      value: p?.template ?? "",
      type: "textarea",
      height: 10,
      placeholder: "Prompt template contents",
    },
    {
      key: "is_skill",
      label: "Is Skill",
      value: p?.is_skill ? "yes" : "no",
      type: "select",
      options: skillOptions,
    },
    { key: "tags", label: "Tags", value: p?.tags?.join(", ") ?? "", placeholder: "coding, review" },
  ];
}

type Props = {
  onRegisterKeyHandler: (handler: ViewKeyHandler) => void;
  onStateChange: (state: ViewState) => void;
};

export function PromptsView({ onRegisterKeyHandler, onStateChange }: Props) {
  const [mode, setMode] = useState<"browse" | "detail" | "form" | "confirm">("browse");
  const [detail, setDetail] = useState<Prompt | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Prompt | null>(null);
  const [formIntent, setFormIntent] = useState<"create" | "edit">("create");
  const [formTarget, setFormTarget] = useState<Prompt | null>(null);
  const editForm = useEditForm();

  const { data, loading, error, refresh, mutate } = usePolling(
    () => client.prompts.list({ limit: 100 }),
    10000,
  );
  const prompts = data?.prompts ?? [];
  const {
    filtered,
    query,
    active: filterActive,
    setQuery,
    setActive: setFilterActive,
  } = useFilter(
    prompts,
    (p) => `${p.name} ${p.description ?? ""} ${p.tags?.join(" ") ?? ""}`,
    true,
  );
  const {
    cursor,
    setCursor,
    handleKey: vimHandleKey,
  } = useVimList(filtered.length, mode === "browse" && !filterActive);

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const filterActiveRef = useRef(filterActive);
  filterActiveRef.current = filterActive;
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const setCursorRef = useRef(setCursor);
  setCursorRef.current = setCursor;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const mutateRef = useRef(mutate);
  mutateRef.current = mutate;
  const editFormRef = useRef(editForm);
  editFormRef.current = editForm;
  const deleteTargetRef = useRef(deleteTarget);
  deleteTargetRef.current = deleteTarget;
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const formIntentRef = useRef(formIntent);
  formIntentRef.current = formIntent;
  const formTargetRef = useRef(formTarget);
  formTargetRef.current = formTarget;

  useEffect(() => {
    const selectedPrompt = filtered[cursor];
    onStateChange({
      mode: filterActive ? "filter" : mode,
      title: "Prompts",
      countLabel: loading ? "Loading prompts…" : `${filtered.length} visible prompts`,
      filterQuery: query,
      filterActive,
      navigationLocked: filterActive || mode !== "browse",
      selectionLabel:
        mode === "detail" && detail
          ? `Prompt detail • ${detail.name}`
          : selectedPrompt
            ? `${selectedPrompt.name} • v${selectedPrompt.version}`
            : "No prompt selected yet.",
      detailId: mode === "detail" ? (detail?.id ?? null) : null,
      statusMessage:
        mode === "detail" ? "Detail actions: e edit • d delete" : "Enter opens detail • n creates",
    });
  }, [mode, query, filterActive, onStateChange, filtered, cursor, detail, loading]);

  const doCreate = useCallback(async (vals: Record<string, string>) => {
    if (!vals.name) throw new Error("Prompt name is required.");
    if (!vals.template) throw new Error("Template is required.");
    const tags = vals.tags
      ? vals.tags
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const created = await client.prompts.create({
      name: vals.name,
      ...(vals.description ? { description: vals.description } : {}),
      template: vals.template,
      is_skill: vals.is_skill === "yes",
      ...(tags ? { tags } : {}),
    });
    return expectApiData(created, "Couldn't create prompt.");
  }, []);

  const doEdit = useCallback(async (vals: Record<string, string>) => {
    const p = formTargetRef.current ?? filteredRef.current[cursorRef.current];
    if (!p) throw new Error("Select a prompt first.");
    const tags = vals.tags
      ? vals.tags
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const updated = await client.prompts.update(p.id, {
      ...(vals.name ? { name: vals.name } : {}),
      ...(vals.description ? { description: vals.description } : {}),
      ...(vals.template ? { template: vals.template } : {}),
      is_skill: vals.is_skill === "yes",
      ...(tags ? { tags } : {}),
    });
    return expectApiData(updated, "Couldn't save prompt.");
  }, []);

  const doCreateRef = useRef(doCreate);
  doCreateRef.current = doCreate;
  const doEditRef = useRef(doEdit);
  doEditRef.current = doEdit;

  const submitCurrentForm = useCallback(async () => {
    const result = editFormRef.current.submit();
    const creating = formIntentRef.current === "create";
    const action = creating ? doCreateRef.current : doEditRef.current;

    if (!editFormRef.current.beginSubmit(creating ? "Creating prompt…" : "Saving prompt…")) return;

    try {
      const savedPrompt = await action(result.values);
      if (savedPrompt) setDetail(savedPrompt);
      editFormRef.current.finishSubmit("success", creating ? "Prompt created." : "Prompt saved.");
      setTimeout(() => {
        editFormRef.current.close();
        setFormTarget(null);
        if (savedPrompt) {
          mutateRef.current((current) => {
            if (!current) return { prompts: [savedPrompt] };
            if (creating) {
              return { prompts: [savedPrompt, ...current.prompts] };
            }
            return {
              prompts: current.prompts.map((p) => (p.id === savedPrompt.id ? savedPrompt : p)),
            };
          });
        }
        setMode("browse");
      }, 700);
    } catch (error) {
      editFormRef.current.finishSubmit("error", formErrorMessage(error, "Couldn't save prompt."));
    }
  }, []);

  const handleKey = useCallback(
    (key: KeyEvent): boolean => {
      if (filterActiveRef.current) {
        return handleFilterInputKey(key.name, setFilterActive);
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
          const p = deleteTargetRef.current;
          if (p) client.prompts.delete(p.id).then(() => refreshRef.current());
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
        if (isFilterToggleKey(key.name)) {
          setFilterActive(true);
          return true;
        }
        if (isOpenDetailKey(key.name)) {
          const p = filteredRef.current[cursorRef.current];
          if (p)
            client.prompts.get(p.id).then((r) => {
              if (r.data) {
                setDetail(r.data);
                setMode("detail");
              }
            });
          return true;
        }
        if (isRefreshKey(key.name)) {
          refreshRef.current();
          return true;
        }
        if (key.name === "n") {
          setFormIntent("create");
          setFormTarget(null);
          editFormRef.current.open(promptFields());
          setMode("form");
          return true;
        }
      }
      if (modeRef.current === "detail") {
        if (
          handleDetailEscapeKey(key.name, () => {
            setMode("browse");
            setDetail(null);
          })
        )
          return true;
        if (key.name === "e" && detailRef.current) {
          setFormIntent("edit");
          setFormTarget(detailRef.current);
          editFormRef.current.open(promptFields(detailRef.current));
          setMode("form");
          return true;
        }
        if (key.name === "d" && detailRef.current) {
          setDeleteTarget(detailRef.current);
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
    const fields = [
      { label: "ID", value: detail.id, color: colors.textDim },
      { label: "Name", value: detail.name },
      { label: "Version", value: `v${detail.version}` },
      {
        label: "Skill",
        value: detail.is_skill ? "yes" : "no",
        color: detail.is_skill ? colors.warning : colors.textDim,
      },
      { label: "Pinned", value: detail.pinned ? "yes" : "no" },
      { label: "Tags", value: detail.tags?.join(", ") ?? "—" },
      { label: "Last Used", value: detail.last_used_at ?? "never" },
      { label: "Created", value: detail.created_at },
    ];
    return (
      <DetailPane
        title={`Prompt: ${detail.name}`}
        fields={fields}
        body={detail.template}
        renderMarkdown
        hint="Esc back • e edit • d delete • Up/Down scroll"
      />
    );
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <ViewToolbar
        title="Prompts"
        countLabel={loading ? "Loading prompts…" : `${filtered.length} visible prompts`}
        filterQuery={query}
        filterActive={filterActive}
        filterPlaceholder="Search by name, tags, or description"
        onFilterChange={setQuery}
        onFilterSubmit={() => setFilterActive(false)}
        statusMessage="Prompt templates and skills share one surface."
      />
      <ResourceTable
        columns={columns}
        data={filtered}
        cursor={cursor}
        keyFn={(p) => p.id}
        loading={loading}
        error={error}
        emptyMessage="No prompts available yet."
        filteredEmptyMessage="No prompts match the current search."
        hasActiveFilter={Boolean(query)}
        selectedSummary={
          filtered[cursor]
            ? `${filtered[cursor]?.name} • v${filtered[cursor]?.version}`
            : "Create a prompt with n."
        }
      />
      {mode === "form" && (
        <EditFormOverlay
          title={formIntent === "create" ? "New Prompt" : "Edit Prompt"}
          fields={editForm.fields}
          focusIdx={editForm.focusIdx}
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
      )}
      {mode === "confirm" && deleteTarget && (
        <ConfirmDialog message={`Delete prompt "${deleteTarget.name}"?`} />
      )}
    </box>
  );
}
