import { open } from "node:fs/promises";
import type { HostRuntime } from "@orc/core/exec-host";

const TAIL_BYTES = 262144;
const REMOTE_TAIL = `
import json, os, sys
args = json.load(sys.stdin)
with open(args['path'], 'rb') as f:
    f.seek(0, os.SEEK_END)
    size = f.tell()
    f.seek(max(0, size - args['limit']))
    sys.stdout.buffer.write(f.read(args['limit']))
`;

/** Only structured Codex questions with a matching response ID are interpreted. */
export function codexQuestionPending(tail: string): boolean {
  const pending = new Set<string>();
  for (const line of tail.split("\n")) {
    let row: { type?: string; payload?: { type?: string; name?: string; call_id?: string } };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    if (
      row.type === "turn_context" ||
      (row.type === "event_msg" && row.payload?.type === "turn_aborted")
    )
      pending.clear();
    if (row.type !== "response_item") continue;
    const item = row.payload;
    if (!item?.call_id || typeof item.call_id !== "string") continue;
    if (item.type === "function_call" && item.name === "request_user_input")
      pending.add(item.call_id);
    else if (item.type === "function_call_output") pending.delete(item.call_id);
  }
  return pending.size > 0;
}

export async function readCodexQuestionPending(
  runtime: HostRuntime,
  path: string,
): Promise<boolean> {
  if (runtime.host.kind === "ssh") {
    const python = await runtime.binary("python3");
    if (!python) throw new Error("python3 is required to inspect remote Codex questions");
    const result = await runtime.exec([python, "-c", REMOTE_TAIL], {
      input: JSON.stringify({ path, limit: TAIL_BYTES }),
      timeoutMs: 30000,
      login: false,
    });
    if (result.code !== 0) throw new Error("Cannot read remote Codex transcript tail");
    return codexQuestionPending(result.stdout);
  }
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - TAIL_BYTES));
    return codexQuestionPending(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await file.close();
  }
}
