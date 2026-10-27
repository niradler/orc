import type { ChatQuestion } from "@orc/core/chat";
import type { ChatAgentOptions } from "@orc/core/chat-options";
import type { OrcMcpMode } from "./orc-mcp.js";
import type { SessionRuleGuard } from "./rules.js";

export type AgentBackendName = "claude" | "acpx" | "a2a" | (string & {});

export type SessionOpts = {
  chatAgentOptions?: ChatAgentOptions | undefined;
  interactive?: boolean | undefined;
  attentionContext?: { chatThreadId: string; sessionTitle: string } | undefined;
  ruleBuiltinActions?: boolean;
  /** Undefined follows the currently selected host; null explicitly means local. */
  executionHost?: string | null | undefined;
  ruleGuard?: SessionRuleGuard;
  cwd: string;
  model?: string | undefined;
  runtimeSessionId?: string | undefined;
  autoApprove?: boolean | undefined;
  acpxAgent?: string | undefined;
  a2aUrl?: string | undefined;
  agentApiUrl?: string | undefined;
  permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions" | undefined;
  systemPromptAppend?: string | undefined;
  agentProfile?: string | undefined;
  toolAllowlist?: string[] | undefined;
  mcpAlwaysLoad?: boolean | undefined;
  /** Explicit ORC connection for chat. Undefined preserves the backend default. */
  orcMcp?: boolean | undefined;
  /** Tool surface of that connection; `meta` serves three search/describe/invoke tools. */
  orcMcpMode?: OrcMcpMode | undefined;
};

export type ImageAttachment = {
  data: Uint8Array;
  mimeType: string;
};

export type PermissionResult = "approved" | "denied" | "session";

export type AgentEvent =
  | { type: "question_request"; data: ChatQuestion }
  | { type: "request_resolved"; data: { requestId: string } }
  | { type: "text"; data: string }
  | { type: "thinking"; data: string }
  | { type: "tool_use"; data: { id: string; name: string; input: string } }
  | {
      type: "tool_result";
      data: { toolUseId: string; content: string; isError: boolean };
    }
  | {
      type: "permission_request";
      data: {
        requestId: string;
        tool: string;
        command: string;
        input?: Record<string, unknown>;
        cwd?: string;
      };
    }
  | {
      type: "result";
      data: { runtimeSessionId?: string | undefined; usage?: unknown };
    }
  | { type: "error"; data: string }
  | { type: "system_status"; data: string };

export type LivePermissionMode = "default" | "acceptEdits" | "bypassPermissions";

/** Approval prompts for file edits that `acceptEdits` answers itself. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "file changes"]);

export function permissionModeAllows(mode: LivePermissionMode | undefined, tool: string): boolean {
  return mode === "bypassPermissions" || (mode === "acceptEdits" && EDIT_TOOLS.has(tool));
}

export interface AgentSession {
  readonly id: string;
  /** Native identity may be known before a turn completes, including on cancellation. */
  getRuntimeSessionId?(): string | undefined;
  send(prompt: string, images?: ImageAttachment[]): Promise<void>;
  respondPermission(requestId: string, result: PermissionResult): void;
  respondQuestion?(requestId: string, answers: Record<string, string[]>): void | Promise<void>;
  /**
   * Loosen approvals for the rest of a running turn: prompts the new mode would not ask
   * for, including ones already pending, are approved. Tightening takes effect next turn.
   */
  setPermissionMode?(mode: LivePermissionMode): void;
  events(): AsyncIterable<AgentEvent>;
  alive(): boolean;
  waitingForHuman?(): boolean;
  close(): Promise<void>;
}

/**
 * How a backend reaches its agent, which is what decides whether a user has to
 * install anything: `in-process` runs inside orc, `cli` shells out to a binary
 * that must exist, `http` talks to a service that must be up.
 */
export type BackendKind = "in-process" | "cli" | "http";

/** Extra detail for `orc doctor` and `GET /backends`, beyond ok/not-ok. */
export type BackendDescription = {
  kind: BackendKind;
  /** What the backend needs, in one line, whether or not it is satisfied. */
  requires: string;
  /** Resolved binary or endpoint, when there is one. */
  target?: string | null;
  /** Where the target came from - PATH, a bundled install, config. */
  source?: string | null;
  version?: string | null;
};

export interface AgentBackend {
  readonly name: AgentBackendName;
  readonly profileCapabilities?: { model: boolean; toolAllowlist: boolean };
  startSession(opts: SessionOpts): Promise<AgentSession>;
  resumeSession(runtimeSessionId: string, opts: SessionOpts): Promise<AgentSession>;
  preflight(opts?: Pick<SessionOpts, "executionHost">): Promise<{ ok: boolean; error?: string }>;
  stop(): Promise<void>;
  /**
   * Optional: describe what this backend needs and what it resolved to.
   * Backends that do not implement it are still reported, just with less detail.
   */
  describe?(): Promise<BackendDescription> | BackendDescription;
}
