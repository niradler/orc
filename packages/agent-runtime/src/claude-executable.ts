import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** The SDK's optional native executable is external to a Bun compiled binary. */
export function resolveClaudeSdkLaunch(
  standalone = Bun.embeddedFiles.length > 0,
  which: (name: string) => string | null = (name) => Bun.which(name),
): { pathToClaudeCodeExecutable?: string; executable?: "node" | "bun" } {
  if (!standalone) return {};
  const cli = which("claude");
  if (!cli) {
    throw new Error(
      "Standalone ORC requires Claude Code installed on PATH; an API key alone cannot supply the SDK executable. Install Claude Code or use the npm ORC distribution.",
    );
  }
  if (!/\.(cmd|bat)$/i.test(cli)) return { pathToClaudeCodeExecutable: cli };

  // Do not pass a Windows shell shim to the SDK's direct process spawn.
  const script = join(dirname(cli), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  const executable = which("node") ? "node" : which("bun") ? "bun" : undefined;
  if (!existsSync(script) || !executable) {
    throw new Error(
      "Claude Code shell shim has no runnable cli.js/interpreter; install the native Claude Code executable on PATH.",
    );
  }
  return { pathToClaudeCodeExecutable: script, executable };
}
