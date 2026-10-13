import { type ExecHost, execHostFor, resolveExecHost } from "@orc/core/exec-host";
import type { SessionOpts } from "./types.js";

/** Resolve the immutable host attached to a session, or the selected host for a new session. */
export function sessionExecHost(opts: SessionOpts): ExecHost {
  return opts.executionHost === undefined ? resolveExecHost() : execHostFor(opts.executionHost);
}
