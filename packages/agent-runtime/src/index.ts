export { ACPX_MISSING_MESSAGE, type AcpxResolution, resolveAcpxCli } from "./acpx.js";
export { type BackendProbe, probeBackend, probeBackends } from "./probe.js";
export { createBackend, hasBackend, listRegisteredBackends, registerBackend } from "./registry.js";
export { openAgentSession, pickUsableBackend } from "./session-factory.js";
export type {
  AgentBackend,
  AgentBackendName,
  AgentEvent,
  AgentSession,
  BackendDescription,
  BackendKind,
  ImageAttachment,
  PermissionResult,
  SessionOpts,
} from "./types.js";

// Registration order matters: `claude` is the in-process SDK backend, and
// claude-cli / codex-cli register under their own names so they are selectable
// and probeable instead of dead code. `codex` (no suffix) stays an acpx agent
// identifier, which is the path that works without a native codex install.
import "./claude-sdk.js";
import "./claude.js";
import "./acpx.js";
import "./codex.js";
import "./a2a.js";
import "./agentapi.js";
