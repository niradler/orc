import { useKeyboard } from "@opentui/react";
import { createOrcClient } from "@orc/sdk";
import type { Job } from "@orc/sdk/types";
import { useCallback, useEffect, useState } from "react";

type Props = { focused: boolean };

export function JobMonitor({ focused }: Props) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(true);
  const client = createOrcClient();

  const load = useCallback(async () => {
    setLoading(true);
    const result = await client.jobs.list();
    if (result.data) setJobs(result.data.jobs);
    setLoading(false);
  }, [client.jobs.list]);

  useEffect(() => {
    load();
  }, [load]);

  useKeyboard((key) => {
    if (!focused) return;
    if (key.name === "up" || key.name === "k") setCursor((c) => Math.max(0, c - 1));
    if (key.name === "down" || key.name === "j") setCursor((c) => Math.min(jobs.length - 1, c + 1));
    if (key.name === "r") load();
    if (key.name === "return") {
      const job = jobs[cursor];
      if (job) client.jobs.trigger(job.id);
    }
  });

  return (
    <box flexDirection="column" gap={0}>
      <box flexDirection="row" gap={2} marginBottom={1}>
        <text fg="#FFFFFF">{"JOBS"}</text>
        <text fg="#555555">{loading ? "loading…" : `${jobs.length} jobs`}</text>
      </box>

      {jobs.length === 0 && !loading && <text fg="#555555">{"  No jobs defined."}</text>}

      {jobs.map((job, i) => {
        const isSelected = focused && i === cursor;
        return (
          <box
            key={job.id}
            flexDirection="row"
            gap={1}
            {...(isSelected ? { backgroundColor: "#1a1a2e" } : {})}
            paddingLeft={1}
          >
            <text fg={isSelected ? "#00BFFF" : "#444"}>{isSelected ? "▶" : " "}</text>
            <text fg={job.enabled ? "#00FF7F" : "#555"} width={2}>
              {job.enabled ? "●" : "○"}
            </text>
            <text fg="#DDDDDD" width={24}>
              {job.name}
            </text>
            <text fg="#666666" width={12}>
              {job.trigger_type}
            </text>
            <text fg="#555555">{`runs:${job.run_count}`}</text>
          </box>
        );
      })}

      {focused && (
        <box marginTop={1}>
          <text fg="#333333">{"↑↓/jk navigate  Enter trigger  r refresh"}</text>
        </box>
      )}
    </box>
  );
}
