import { useKeyboard } from "@opentui/react";
import { createOrcClient } from "@orc/sdk";
import type { Memory } from "@orc/sdk/types";
import { useCallback, useState } from "react";

const IMPORTANCE_COLOR: Record<string, string> = {
  critical: "#FF3333",
  high: "#FF8C00",
  normal: "#CCCCCC",
  low: "#666666",
};

type Layer = "search" | "list" | "detail";

type Props = { focused: boolean };

export function MemBrowser({ focused }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Memory[]>([]);
  const [cursor, setCursor] = useState(0);
  const [detail, setDetail] = useState<Memory | null>(null);
  const [layer, setLayer] = useState<Layer>("search");
  const [loading, setLoading] = useState(false);
  const client = createOrcClient();

  const search = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setResults([]);
        return;
      }
      setLoading(true);
      const result = await client.memories.search(q, undefined, 20);
      if (result.data) setResults(result.data.results);
      setLoading(false);
      setLayer("list");
      setCursor(0);
    },
    [client.memories.search],
  );

  useKeyboard((key) => {
    if (!focused) return;

    if (layer === "list") {
      if (key.name === "up" || key.name === "k") setCursor((c) => Math.max(0, c - 1));
      if (key.name === "down" || key.name === "j")
        setCursor((c) => Math.min(results.length - 1, c + 1));
      if (key.name === "return") {
        setDetail(results[cursor] ?? null);
        setLayer("detail");
      }
      if (key.name === "escape") {
        setLayer("search");
      }
    } else if (layer === "detail") {
      if (key.name === "escape" || key.name === "q") {
        setDetail(null);
        setLayer("list");
      }
    }
  });

  const handleInput = useCallback((q: string) => setQuery(q), []);
  const _handleSubmit = useCallback(() => {
    search(query);
  }, [query, search]);

  return (
    <box flexDirection="column" gap={0}>
      <box flexDirection="row" gap={2} marginBottom={1}>
        <text fg="#FFFFFF">{"MEMORY"}</text>
        <text fg="#555555">{"FTS5 BM25"}</text>
        {loading && <text fg="#555555">{" searching…"}</text>}
      </box>

      {layer === "search" && (
        <box
          flexDirection="row"
          gap={1}
          paddingLeft={1}
          marginBottom={1}
          {...(focused ? { borderStyle: "single", borderColor: "#00BFFF" } : {})}
        >
          <text fg="#555555">{"/"}</text>
          <input
            value={query}
            placeholder="search memories…"
            width={50}
            onInput={handleInput}
            onSubmit={() => {
              search(query);
            }}
            focused={focused && layer === "search"}
            textColor="#DDDDDD"
            cursorColor="#00BFFF"
          />
        </box>
      )}

      {layer !== "detail" &&
        results.map((m, i) => {
          const isSelected = layer === "list" && focused && i === cursor;
          return (
            <box
              key={m.id}
              flexDirection="row"
              gap={1}
              {...(isSelected ? { backgroundColor: "#1a1a2e" } : {})}
              paddingLeft={1}
            >
              <text fg={isSelected ? "#00BFFF" : "#444"}>{isSelected ? "▶" : " "}</text>
              <text fg={IMPORTANCE_COLOR[m.importance] ?? "#888"} width={8}>
                {m.importance}
              </text>
              <text fg="#888888" width={12}>
                {m.scope ?? "global"}
              </text>
              <text fg="#DDDDDD">
                {m.content.length > 60 ? `${m.content.slice(0, 60)}…` : m.content}
              </text>
            </box>
          );
        })}

      {layer === "detail" && detail && (
        <box borderStyle="single" borderColor="#444" flexDirection="column" gap={1} padding={1}>
          <box flexDirection="row" gap={2}>
            <text fg={IMPORTANCE_COLOR[detail.importance] ?? "#888"}>{detail.importance}</text>
            <text fg="#555555">{`scope:${detail.scope ?? "—"}`}</text>
            {detail.tags && detail.tags.length > 0 && (
              <text fg="#555555">{`tags:${detail.tags.join(",")}`}</text>
            )}
          </box>
          <text fg="#DDDDDD">{detail.content}</text>
          <text fg="#333333">{"Esc/q back"}</text>
        </box>
      )}

      {focused && layer === "list" && results.length > 0 && (
        <box marginTop={1}>
          <text fg="#333333">{"↑↓/jk navigate  Enter detail  Esc new search"}</text>
        </box>
      )}
    </box>
  );
}
