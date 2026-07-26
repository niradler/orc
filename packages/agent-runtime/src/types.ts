export type AgentBackendName = "claude" | "acpx" | "a2a" | (string & {});

export type SessionOpts = {
  cwd: string;
  model?: string | undefined;
  runtimeSessionId?: string | undefined;
  autoApprove?: boolean | undefined;
  acpxAgent?: string | undefined;
  a2aUrl?: string | undefined;
  agentApiUrl?: string | undefined;
  permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions" | undefined;
  systemPromptAppend?: string | undefined;
};

export type ImageAttachment = {
  data: Uint8Array;
  mimeType: string;
};

export type PermissionResult = "approved" | "denied" | "session";

export type AgentEvent =
  | { type: "text"; data: string }
  | { type: "thinking"; data: string }
  | { type: "tool_use"; data: { id: string; name: string; input: string } }
  | { type: "tool_result"; data: { toolUseId: string; content: string; isError: boolean } }
  | { type: "permission_request"; data: { requestId: string; tool: string; command: string } }
  | { type: "result"; data: { runtimeSessionId?: string | undefined; usage?: unknown } }
  | { type: "error"; data: string }
  | { type: "system_status"; data: string };

export interface AgentSession {
  readonly id: string;
  send(prompt: string, images?: ImageAttachment[]): Promise<void>;
  respondPermission(requestId: string, result: PermissionResult): void;
  events(): AsyncIterable<AgentEvent>;
  alive(): boolean;
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
  startSession(opts: SessionOpts): Promise<AgentSession>;
  resumeSession(runtimeSessionId: string, opts: SessionOpts): Promise<AgentSession>;
  preflight(): Promise<{ ok: boolean; error?: string }>;
  stop(): Promise<void>;
  /**
   * Optional: describe what this backend needs and what it resolved to.
   * Backends that do not implement it are still reported, just with less detail.
   */
  describe?(): Promise<BackendDescription> | BackendDescription;
}
