// What a terminal child sees should look like a fresh terminal window, not like a child of
// whatever launched the API: no ORC credentials and no markers of a parent coding-agent session
// (a nested claude otherwise believes it is a subagent and turns features off).
const STRIPPED = [
  /^ORC_API_SECRET$/,
  /^CLAUDECODE$/,
  /^CLAUDE_PID$/,
  /^CLAUDE_AGENT_SDK_/,
  /^CLAUDE_PREVIEW_/,
  /^CLAUDE_CODE_(ENTRYPOINT|CHILD_SESSION|SESSION_.*|HOST_SESSION_ID|MESSAGING_.*|SSE_PORT)$/,
  /^CLAUDE_CODE_(DESKTOP_APP_VERSION|SDK_.*|ENABLE_SDK_.*|TERMINAL_MCP_TOOLS|EMIT_.*)$/,
  /^CLAUDE_CODE_(EAGER_FLUSH|REPORT_FINDINGS|DISABLE_TERMINAL_TITLE)$/,
];

export function buildPtyEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || STRIPPED.some((pattern) => pattern.test(key))) continue;
    out[key] = value;
  }
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  out.TERM_PROGRAM = "orc";
  return out;
}
