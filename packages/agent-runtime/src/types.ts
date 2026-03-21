export type AgentBackendName = "claude" | "acpx" | "a2a" | (string & {});

export type SessionOpts = {
  cwd: string;
  model?: string | undefined;
  runtimeSessionId?: string | undefined;
  autoApprove?: boolean | undefined;
  acpxAgent?: string | undefined;
  a2aUrl?: string | undefined;
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
  | { type: "error"; data: string };

export interface AgentSession {
  readonly id: string;
  send(prompt: string, images?: ImageAttachment[]): Promise<void>;
  respondPermission(requestId: string, result: PermissionResult): void;
  events(): AsyncIterable<AgentEvent>;
  alive(): boolean;
  close(): Promise<void>;
}

export interface AgentBackend {
  readonly name: AgentBackendName;
  startSession(opts: SessionOpts): Promise<AgentSession>;
  resumeSession(runtimeSessionId: string, opts: SessionOpts): Promise<AgentSession>;
  preflight(): Promise<{ ok: boolean; error?: string }>;
  stop(): Promise<void>;
}
