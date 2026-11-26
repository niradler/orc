export { type AcpEffortChoice, SteerNotConsumedError } from "./acp.js";
export {
  ACPX_MISSING_MESSAGE,
  type AcpxResolution,
  acpxMissingMessage,
  resolveAcpx,
  resolveAcpxCli,
} from "./acpx.js";
export { chatBackendFor, UNKNOWN_CAPABILITIES } from "./capabilities.js";
export { hostClaudeLoggedIn } from "./claude-sdk.js";
export {
  type AgentModel,
  discoverAgentCommands,
  discoverAgentModels,
  discoverOpenCodeEffortChoices,
} from "./models.js";
export { type BackendProbe, probeBackend, probeBackends } from "./probe.js";
export {
  backendSupportsToolAllowlist,
  createBackend,
  hasBackend,
  listRegisteredBackends,
  registerBackend,
  toolAllowlistBackends,
} from "./registry.js";
export { type RuleGap, sessionRules } from "./rules.js";
export {
  openAgentSession,
  pickUsableBackend,
  resolveToolAllowlistSupport,
} from "./session-factory.js";
export type {
  AgentBackend,
  AgentBackendName,
  AgentEvent,
  AgentSession,
  AgentUnexpectedExit,
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
import "./acp.js";
import "./pi.js";
import "./codex.js";
import "./a2a.js";
import "./agentapi.js";
