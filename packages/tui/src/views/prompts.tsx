import { useKeyboard } from "@opentui/react";
import { createOrcClient } from "@orc/sdk";
import type { Prompt } from "@orc/sdk/types";
import { useCallback, useState } from "react";
import { DetailPane } from "../components/detail-pane.js";
import { ResourceTable } from "../components/resource-table.js";
import { useFilter } from "../hooks/use-filter.js";
import { usePolling } from "../hooks/use-polling.js";
import { useVimList } from "../hooks/use-vim-list.js";
import { colors } from "../theme.js";
import type { Column, ViewMode } from "../types.js";

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
      const text = p.description ?? "—";
      return text.length > 38 ? `${text.slice(0, 38)}…` : text;
    },
    color: () => colors.textDim,
  },
  {
    key: "version",
    label: "Ver",
    width: 6,
    render: (p) => `v${p.version}`,
  },
  {
    key: "pinned",
    label: "Pin",
    width: 5,
    render: (p) => (p.pinned ? "📌" : ""),
  },
  {
    key: "tags",
    label: "Tags",
    width: 20,
    render: (p) => (p.tags?.length ? p.tags.join(", ") : "—"),
    color: () => colors.textDim,
  },
];

export function PromptsView() {
  const [mode, setMode] = useState<ViewMode>("list");
  const [detail, setDetail] = useState<Prompt | null>(null);

  const { data, loading, refresh } = usePolling(
    () => client.prompts.list({ limit: 100 }),
    10000,
  );

  const prompts = data?.prompts ?? [];

  const { filtered, query, active: filterActive } = useFilter(
    prompts,
    (p) => `${p.name} ${p.description ?? ""} ${p.tags?.join(" ") ?? ""}`,
    mode === "list",
  );

  const { cursor } = useVimList(filtered.length, mode === "list" && !filterActive);

  const openDetail = useCallback(async () => {
    const prompt = filtered[cursor];
    if (!prompt) return;
    const result = await client.prompts.get(prompt.id);
    if (result.data) {
      setDetail(result.data);
      setMode("detail");
    }
  }, [filtered, cursor]);

  useKeyboard((key) => {
    if (mode === "list" && !filterActive) {
      if (key.name === "return") openDetail();
      if (key.name === "r") refresh();
    }
    if (mode === "detail" && key.name === "escape") {
      setMode("list");
      setDetail(null);
    }
  });

  if (mode === "detail" && detail) {
    const fields = [
      { label: "ID", value: detail.id, color: colors.textDim },
      { label: "Name", value: detail.name },
      { label: "Version", value: `v${detail.version}` },
      { label: "Skill", value: detail.is_skill ? "yes" : "no", color: detail.is_skill ? colors.warning : colors.textDim },
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
      />
    );
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" gap={2} marginBottom={0} paddingLeft={1}>
        <text fg={colors.text}>{"PROMPTS"}</text>
        <text fg={colors.textDim}>
          {loading ? "loading…" : `${filtered.length} prompts`}
        </text>
        {query && <text fg={colors.accent}>{`/${query}`}</text>}
      </box>
      <ResourceTable
        columns={columns}
        data={filtered}
        cursor={cursor}
        keyFn={(p) => p.id}
      />
    </box>
  );
}
