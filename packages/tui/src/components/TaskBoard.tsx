import { useKeyboard } from "@opentui/react";
import { createOrcClient } from "@orc/sdk";
import type { Task } from "@orc/sdk/types";
import { useCallback, useEffect, useState } from "react";

const STATUS_COLOR: Record<string, string> = {
  todo: "#888888",
  doing: "#00BFFF",
  review: "#FFD700",
  changes_requested: "#FF6B6B",
  blocked: "#FF4500",
  done: "#00FF7F",
  cancelled: "#555555",
};

const PRIORITY_COLOR: Record<string, string> = {
  critical: "#FF3333",
  high: "#FF8C00",
  normal: "#CCCCCC",
  low: "#666666",
};

type Props = { focused: boolean };

export function TaskBoard({ focused }: Props) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(true);
  const client = createOrcClient();

  const load = useCallback(async () => {
    setLoading(true);
    const result = await client.tasks.list({ limit: 50 });
    if (result.data) setTasks(result.data.tasks);
    setLoading(false);
  }, [client.tasks.list]);

  useEffect(() => {
    load();
  }, [load]);

  useKeyboard((key) => {
    if (!focused) return;
    if (key.name === "up" || key.name === "k") setCursor((c) => Math.max(0, c - 1));
    if (key.name === "down" || key.name === "j")
      setCursor((c) => Math.min(tasks.length - 1, c + 1));
    if (key.name === "r") load();
  });

  const active = tasks.filter((t) => !["done", "cancelled"].includes(t.status));

  return (
    <box flexDirection="column" gap={0}>
      <box flexDirection="row" gap={2} marginBottom={1}>
        <text fg="#FFFFFF">{"TASKS"}</text>
        <text fg="#555555">{loading ? "loading…" : `${active.length} active`}</text>
      </box>

      {active.length === 0 && !loading && <text fg="#555555">{"  No active tasks."}</text>}

      {active.map((task, i) => {
        const isSelected = focused && i === cursor;
        return (
          <box
            key={task.id}
            flexDirection="row"
            gap={1}
            {...(isSelected ? { backgroundColor: "#1a1a2e" } : {})}
            paddingLeft={1}
          >
            <text fg={isSelected ? "#00BFFF" : "#444"}>{isSelected ? "▶" : " "}</text>
            <text fg={STATUS_COLOR[task.status] ?? "#888"} width={20}>
              {task.status}
            </text>
            <text fg={PRIORITY_COLOR[task.priority] ?? "#888"} width={8}>
              {task.priority}
            </text>
            <text fg="#DDDDDD">{task.title}</text>
          </box>
        );
      })}

      {focused && (
        <box marginTop={1}>
          <text fg="#333333">{"↑↓/jk navigate  r refresh"}</text>
        </box>
      )}
    </box>
  );
}
