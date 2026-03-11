import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useState } from "react";
import { JobMonitor } from "./JobMonitor.js";
import { MemBrowser } from "./MemBrowser.js";
import { TaskBoard } from "./TaskBoard.js";

const TABS = ["tasks", "jobs", "mem"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  tasks: "Tasks",
  jobs: "Jobs",
  mem: "Memory",
};

export function Dashboard() {
  const [tab, setTab] = useState<Tab>("tasks");
  const { width } = useTerminalDimensions();

  useKeyboard((key) => {
    if (key.name === "tab") {
      setTab((t) => {
        const idx = TABS.indexOf(t);
        return TABS[(idx + 1) % TABS.length] ?? "tasks";
      });
    }
    if (key.name === "1") setTab("tasks");
    if (key.name === "2") setTab("jobs");
    if (key.name === "3") setTab("mem");
    if (key.ctrl && key.name === "q") process.exit(0);
  });

  return (
    <box flexDirection="column" width={width}>
      <box
        flexDirection="row"
        gap={0}
        backgroundColor="#0d0d1a"
        paddingLeft={1}
        paddingRight={1}
        marginBottom={1}
      >
        <text fg="#444444">{"orc"}</text>
        <text fg="#222222">{"  │  "}</text>
        {TABS.map((t, i) => (
          <box key={t} flexDirection="row">
            <text
              fg={tab === t ? "#00BFFF" : "#555555"}
              {...(tab === t ? { backgroundColor: "#111133" } : {})}
              paddingLeft={1}
              paddingRight={1}
            >
              {`${i + 1}:${TAB_LABELS[t]}`}
            </text>
            <text fg="#222222">{"  "}</text>
          </box>
        ))}
        <text fg="#222222">{"  Ctrl+Q quit  Tab cycle"}</text>
      </box>

      <box flexDirection="column" paddingLeft={2} paddingRight={2}>
        {tab === "tasks" && <TaskBoard focused />}
        {tab === "jobs" && <JobMonitor focused />}
        {tab === "mem" && <MemBrowser focused />}
      </box>
    </box>
  );
}
