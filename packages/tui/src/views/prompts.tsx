import { createOrcClient } from "@orc/sdk";
import type { Prompt } from "@orc/sdk/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { DetailPane } from "../components/detail-pane.js";
import { EditFormOverlay, type FormField, useEditForm } from "../components/edit-form.js";
import { ResourceTable } from "../components/resource-table.js";
import { useFilter } from "../hooks/use-filter.js";
import { usePolling } from "../hooks/use-polling.js";
import { useVimList } from "../hooks/use-vim-list.js";
import { colors } from "../theme.js";
import type { Column, KeyEvent, ViewKeyHandler, ViewMode } from "../types.js";

const client = createOrcClient();

const columns: Column<Prompt>[] = [
  {
    key: "skill",
    label: " ",
    width: 3,
    render: (p) => (p.is_skill ? "⚡" : " "),
    color: () => colors.warning,
  },
  { key: "name", label: "Name", width: 24, render: (p) => p.name },
  {
    key: "desc",
    label: "Description",
    width: 40,
    render: (p) => {
      const t = p.description ?? "—";
      return t.length > 38 ? `${t.slice(0, 38)}…` : t;
    },
    color: () => colors.textDim,
  },
  { key: "version", label: "Ver", width: 6, render: (p) => `v${p.version}` },
  { key: "pinned", label: "Pin", width: 5, render: (p) => (p.pinned ? "📌" : "") },
  {
    key: "tags",
    label: "Tags",
    width: 20,
    render: (p) => (p.tags?.length ? p.tags.join(", ") : "—"),
    color: () => colors.textDim,
  },
];

function promptFields(p?: Prompt): FormField[] {
  return [
    { key: "name", label: "Name", value: p?.name ?? "" },
    { key: "description", label: "Description", value: p?.description ?? "" },
    { key: "template", label: "Template", value: p?.template ?? "" },
    {
      key: "is_skill",
      label: "Is Skill",
      value: p?.is_skill ? "yes" : "no",
      options: ["no", "yes"],
    },
    { key: "tags", label: "Tags", value: p?.tags?.join(", ") ?? "" },
  ];
}

type Props = { onRegisterKeyHandler: (handler: ViewKeyHandler) => void };

export function PromptsView({ onRegisterKeyHandler }: Props) {
  const [mode, setMode] = useState<ViewMode>("list");
  const [detail, setDetail] = useState<Prompt | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Prompt | null>(null);
  const editForm = useEditForm();

  const { data, loading, refresh } = usePolling(() => client.prompts.list({ limit: 100 }), 10000);
  const prompts = data?.prompts ?? [];
  const {
    filtered,
    query,
    active: filterActive,
    handleKey: filterHandleKey,
  } = useFilter(
    prompts,
    (p) => `${p.name} ${p.description ?? ""} ${p.tags?.join(" ") ?? ""}`,
    mode === "list",
  );
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
  const deleteTargetRef = useRef(deleteTarget);
  deleteTargetRef.current = deleteTarget;

  const submitCreate = useCallback(async (vals: Record<string, string>) => {
    if (!vals.name || !vals.template) return;
    const tags = vals.tags
      ? vals.tags
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    await client.prompts.create({
      name: vals.name,
      ...(vals.description ? { description: vals.description } : {}),
      template: vals.template,
      is_skill: vals.is_skill === "yes",
      ...(tags ? { tags } : {}),
    });
    setMode("list");
    refreshRef.current();
  }, []);

  const submitEdit = useCallback(async (vals: Record<string, string>) => {
    const p = filteredRef.current[cursorRef.current];
    if (!p) return;
    const tags = vals.tags
      ? vals.tags
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    await client.prompts.update(p.id, {
      ...(vals.name ? { name: vals.name } : {}),
      ...(vals.description ? { description: vals.description } : {}),
      ...(vals.template ? { template: vals.template } : {}),
      is_skill: vals.is_skill === "yes",
      ...(tags ? { tags } : {}),
    });
    setMode("list");
    refreshRef.current();
  }, []);

  const submitCreateRef = useRef(submitCreate);
  submitCreateRef.current = submitCreate;
  const submitEditRef = useRef(submitEdit);
  submitEditRef.current = submitEdit;

  const handleKey = useCallback(
    (key: KeyEvent): boolean => {
      if (modeRef.current === "edit" || modeRef.current === "create") {
        const onSubmit =
          modeRef.current === "create" ? submitCreateRef.current : submitEditRef.current;
        editFormRef.current.handleKey(key, onSubmit);
        if (!editFormRef.current.active) setMode("list");
        return true;
      }
      if (modeRef.current === "confirm") {
        if (key.name === "y") {
          const p = deleteTargetRef.current;
          if (p) client.prompts.delete(p.id).then(() => refreshRef.current());
          setDeleteTarget(null);
          setMode("list");
          return true;
        }
        if (key.name === "n" || key.name === "escape") {
          setDeleteTarget(null);
          setMode("list");
          return true;
        }
        return true;
      }
      if (filterHandleKey(key)) return true;
      if (modeRef.current === "list" && !filterActiveRef.current) {
        if (vimHandleKey(key)) return true;
        if (key.name === "return") {
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
        if (key.name === "r") {
          refreshRef.current();
          return true;
        }
        if (key.name === "n") {
          editFormRef.current.open(promptFields());
          setMode("create");
          return true;
        }
        if (key.name === "e") {
          const p = filteredRef.current[cursorRef.current];
          if (p) {
            editFormRef.current.open(promptFields(p));
            setMode("edit");
          }
          return true;
        }
        if (key.name === "d") {
          const p = filteredRef.current[cursorRef.current];
          if (p) {
            setDeleteTarget(p);
            setMode("confirm");
          }
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
    return <DetailPane title={`Prompt: ${detail.name}`} fields={fields} body={detail.template} />;
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" gap={2} marginBottom={0} paddingLeft={1}>
        <text fg={colors.text}>{"PROMPTS"}</text>
        <text fg={colors.textDim}>{loading ? "loading…" : `${filtered.length} prompts`}</text>
        {query && <text fg={colors.accent}>{`/${query}`}</text>}
      </box>
      <ResourceTable columns={columns} data={filtered} cursor={cursor} keyFn={(p) => p.id} />
      <EditFormOverlay
        title={mode === "create" ? "New Prompt" : "Edit Prompt"}
        fields={editForm.fields}
        focusIdx={editForm.focusIdx}
        editing={editForm.editing}
        active={mode === "edit" || mode === "create"}
      />
      <ConfirmDialog
        message={deleteTarget ? `Delete prompt "${deleteTarget.name}"?` : ""}
        active={mode === "confirm"}
      />
    </box>
  );
}
