export { createBackend, hasBackend, listRegisteredBackends, registerBackend } from "./registry.js";
export type {
  AgentBackend,
  AgentBackendName,
  AgentEvent,
  AgentSession,
  ImageAttachment,
  PermissionResult,
  SessionOpts,
} from "./types.js";

import "./claude-sdk.js"; // replaces ./claude.js
import "./acpx.js";
import "./a2a.js";
import "./agentapi.js";
