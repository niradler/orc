import type { HostRuntime } from "@orc/core/exec-host";
import { loadTranscriptBytes } from "./transcript-source.js";

type Session = {
  backend: string;
  runtime_session_id: string | null;
  transcript_path: string | null;
};

function lines(bytes: Uint8Array, marker: string): unknown[] {
  return new TextDecoder()
    .decode(bytes)
    .split("\n")
    .filter((line) => line.includes(marker))
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function claudeLinks(runtime: HostRuntime, children: Session[]) {
  const links = new Map<string, string>();
  for (const child of children) {
    if (!child.runtime_session_id || !child.transcript_path?.endsWith(".jsonl")) continue;
    try {
      const meta = record(
        JSON.parse(
          new TextDecoder().decode(
            await runtime.readFile(
              child.transcript_path.replace(/\.jsonl$/, ".meta.json"),
              64 * 1024,
            ),
          ),
        ),
      );
      if (typeof meta.toolUseId === "string") links.set(child.runtime_session_id, meta.toolUseId);
    } catch {}
  }
  return links;
}

function codexLinks(bytes: Uint8Array) {
  const links = new Map<string, string>();
  for (const line of lines(bytes, "SubAgentActivity")) {
    const item = record(record(record(line).payload).item);
    if (
      item.type === "SubAgentActivity" &&
      typeof item.agent_thread_id === "string" &&
      typeof item.id === "string" &&
      !links.has(item.agent_thread_id)
    )
      links.set(item.agent_thread_id, item.id);
  }
  return links;
}

function opencodeLinks(bytes: Uint8Array) {
  const links = new Map<string, string>();
  for (const line of lines(bytes, "sessionId")) {
    const parts = record(line).parts;
    for (const part of Array.isArray(parts) ? parts : []) {
      const tool = record(part);
      const metadata = record(record(tool.state).metadata);
      if (typeof metadata.sessionId === "string" && typeof tool.callID === "string")
        links.set(metadata.sessionId, tool.callID);
    }
  }
  return links;
}

export async function subagentToolCalls(
  runtime: HostRuntime,
  parent: Session,
  children: Session[],
): Promise<Map<string, string>> {
  if (parent.backend === "claude") return claudeLinks(runtime, children);
  if (parent.backend !== "codex" && parent.backend !== "opencode") return new Map();
  if (!parent.transcript_path) return new Map();
  try {
    const bytes = await loadTranscriptBytes(
      runtime,
      parent.backend,
      parent.transcript_path,
      parent.runtime_session_id,
    );
    return parent.backend === "codex" ? codexLinks(bytes) : opencodeLinks(bytes);
  } catch {
    return new Map();
  }
}
