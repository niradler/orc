export const CODE_LIMITS = {
  sourceBytes: 32 * 1024,
  requestChars: 32 * 1024,
  responseBytes: 512 * 1024,
  totalResponseBytes: 4 * 1024 * 1024,
  resultChars: 8192,
  resultPreviewChars: 2048,
  jsonDepth: 32,
  jsonItems: 2048,
  logChars: 256,
  logLines: 16,
  memoryBytes: 64 * 1024 * 1024,
  defaultTimeoutMs: 15_000,
  maxTimeoutMs: 25_000,
  requests: 64,
  parallelCalls: 4,
  executions: 4,
  maxPauseMs: 300_000,
} as const;

export interface CodeOutput {
  result: unknown;
  logs: string[];
  truncated: boolean;
  /** Why a truncated result was dropped, so it never reads as an empty success. */
  message?: string;
  /** Characters the script returned before the result limit dropped it. */
  result_chars?: number;
  limit_chars?: number;
  /** Bounded start of the dropped value, for orientation only. */
  preview?: string;
}

export type WorkerInput =
  | { type: "start"; code: string; deadline: number; wasm?: ArrayBuffer }
  | { type: "deadline"; deadline: number }
  | { type: "reply"; id: number; payload: string };

export type WorkerOutput =
  | { type: "ready" }
  | { type: "request"; id: number; payload: string }
  | { type: "done"; output: CodeOutput }
  | { type: "failure"; message: string };

/** Bound JSON complexity before parsing or passing it through the MCP SDK. */
export function hasBoundedJsonShape(json: string): boolean {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let items = 1;
  for (const character of json) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      if (++depth > CODE_LIMITS.jsonDepth || ++items > CODE_LIMITS.jsonItems) return false;
    } else if (character === "}" || character === "]") depth--;
    else if (character === "," && ++items > CODE_LIMITS.jsonItems) return false;
  }
  return true;
}
