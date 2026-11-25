import { ChatAgentOptionsSchema, chatRuntime } from "@orc/core/chat-options";
import { chatRuntimeFor } from "@orc/core/coding-agents";
import { useEffect, useId, useState } from "react";
import { agentDisplayName } from "@/components/AgentIcon";
import { HelpPopover } from "@/components/HelpPopover";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAgentBackend } from "@/hooks/useAgentCapabilities";
import { useChat } from "@/hooks/useChat";

export function ChatAgentOptionsEditor() {
  const { config, applyAgentOptions, thread, streaming } = useChat();
  const inputId = useId();
  const runtime = chatRuntime(config.agent);
  // The server may resolve an agent to direct ACP through agent_loop.acp_commands
  // even when the static table says ACPX, so ask it for the real adapter.
  const backend = useAgentBackend(config.agent, thread);
  const directAcp = ["acp", "opencode"].includes(backend ?? chatRuntimeFor(config.agent));
  const saved = config.agentOptions[config.agent];
  const legacyArgs = directAcp && saved?.runtime === "acpx" ? saved.args : [];
  const initial = JSON.stringify(
    saved?.runtime === "claude-sdk" || saved?.runtime === "pi"
      ? saved.options
      : ((saved && "args" in saved ? saved.args : undefined) ??
          (["claude-sdk", "pi"].includes(runtime) ? {} : [])),
    null,
    2,
  );
  const [draft, setDraft] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    setDraft(initial);
    setError("");
  }, [initial]);
  async function apply() {
    setError("");
    setFeedback("");
    let raw: unknown;
    try {
      raw = JSON.parse(draft);
    } catch {
      setError(
        runtime === "claude-sdk" || runtime === "pi"
          ? "Enter SDK options as a JSON object."
          : "Enter arguments as a JSON array of strings.",
      );
      return;
    }
    const parsed = ChatAgentOptionsSchema.safeParse(
      runtime === "claude-sdk" || runtime === "pi" || runtime === "opencode"
        ? { runtime, options: raw }
        : { runtime, args: raw },
    );
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(" "));
      return;
    }
    const agent = config.agent;
    const threadId = thread?.id;
    setPending(true);
    try {
      if (!(await applyAgentOptions(agent, parsed.data))) return;
      setFeedback(
        threadId ? "Saved. Applies to your next message." : "Applies when you start this session.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Launch options could not be saved.");
    } finally {
      setPending(false);
    }
  }
  function example() {
    if (runtime === "claude-sdk") {
      setDraft(
        JSON.stringify(
          {
            ...(saved?.runtime === "claude-sdk" ? saved.options : {}),
            permissionMode: "bypassPermissions",
          },
          null,
          2,
        ),
      );
    } else if (runtime === "pi") {
      setDraft(
        JSON.stringify(
          { ...(saved?.runtime === "pi" ? saved.options : {}), thinkingLevel: "high" },
          null,
          2,
        ),
      );
    } else if (runtime === "acpx") {
      const values =
        saved?.runtime === "acpx"
          ? saved.args.filter(
              (value) => !["--approve-all", "--approve-reads", "--deny-all"].includes(value),
            )
          : [];
      setDraft(JSON.stringify([...values, "--approve-all"], null, 2));
    } else setDraft(JSON.stringify(["-c", 'model_reasoning_effort="high"'], null, 2));
    setFeedback("");
    setError("");
  }
  const agentName = agentDisplayName(config.agent);
  const fieldLabel =
    runtime === "claude-sdk"
      ? "Claude SDK options (JSON)"
      : runtime === "pi"
        ? "Pi options (JSON)"
        : runtime === "codex"
          ? "Codex App Server arguments (JSON array)"
          : `${agentName} arguments via ACPX (JSON array)`;
  const help = (
    <HelpPopover label="Agent launch options" testId="chat-agent-options-help">
      {directAcp
        ? "Runs its own ACP command from ORC's agent_loop.acp_commands; provider env and executables live in Settings → Providers."
        : runtime === "claude-sdk"
          ? 'Example: {"maxTurns": 20, "effort": "high"}. Fields: permissionMode, maxTurns, maxBudgetUsd, effort, thinking, fallbackModel, extraArgs.'
          : runtime === "pi"
            ? 'Example: {"thinkingLevel":"high"}. Fields: thinkingLevel, steeringMode, followUpMode, autoCompaction, autoRetry. Pi keeps queue and retry changes on the host.'
            : runtime === "acpx"
              ? 'Example: ["--approve-all"]. Also --approve-reads, --deny-all, --ttl and --non-interactive-permissions. Provider env and secrets live in Settings → Providers.'
              : "Use -c/--config for reasoning, verbosity and web search, or --enable/--disable. Sandbox and approvals are set above."}{" "}
      Options are kept per agent and apply to the next turn.
    </HelpPopover>
  );
  return (
    <details data-testid="chat-agent-options" className="min-w-0 space-y-3 text-sm">
      <summary className="min-h-11 cursor-pointer py-3">Advanced launch options</summary>
      {directAcp ? (
        <div className="flex items-start gap-1">
          <p
            className="min-w-0 text-xs text-muted-foreground"
            data-testid="chat-agent-options-direct-acp"
          >
            {agentName} connects over ACP directly, so ACPX launch flags do not apply. Set its
            command in ORC configuration and its profile values in Settings → Providers.
          </p>
          {help}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-start gap-1">
            <label className="min-w-0" htmlFor={inputId}>
              {fieldLabel}
            </label>
            {help}
          </div>
          <Textarea
            id={inputId}
            data-testid="chat-agent-options-input"
            aria-label="Agent launch options"
            rows={6}
            maxLength={20000}
            value={draft}
            disabled={streaming || pending}
            onChange={(event) => {
              setDraft(event.target.value);
              setFeedback("");
            }}
            className="font-mono text-xs"
          />
        </div>
      )}
      {directAcp && legacyArgs.length > 0 && (
        <div className="space-y-2 rounded-md border border-warning/50 bg-warning/10 p-2 text-xs">
          <p className="text-warning">
            Saved ACPX arguments cannot be used with this agent and will fail the next turn.
          </p>
          <Button
            type="button"
            variant="outline"
            data-testid="chat-agent-options-clear"
            disabled={streaming || pending}
            onClick={() => {
              setError("");
              setFeedback("");
              setPending(true);
              void applyAgentOptions(config.agent, { runtime: "acpx", args: [] })
                .then((ok) => {
                  if (ok) setFeedback("Saved ACPX arguments were cleared.");
                })
                .catch((cause: unknown) => {
                  setError(
                    cause instanceof Error ? cause.message : "Launch options could not be saved.",
                  );
                })
                .finally(() => setPending(false));
            }}
          >
            Clear saved arguments
          </Button>
        </div>
      )}
      {!directAcp && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            data-testid="chat-agent-options-example"
            disabled={streaming || pending}
            onClick={example}
          >
            {runtime === "codex" || runtime === "pi"
              ? "High reasoning example"
              : runtime === "acpx"
                ? "Permission example"
                : "SDK options example"}
          </Button>
          <Button
            type="button"
            data-testid="chat-agent-options-apply"
            disabled={streaming || pending}
            onClick={() => void apply()}
          >
            {pending ? "Saving…" : "Apply options"}
          </Button>
        </div>
      )}
      {error && (
        <p
          role="alert"
          data-testid="chat-agent-options-error"
          className="wrap-break-word text-error"
        >
          {error}
        </p>
      )}
      {feedback && (
        <p
          role="status"
          data-testid="chat-agent-options-feedback"
          className="text-muted-foreground"
        >
          {feedback}
        </p>
      )}
    </details>
  );
}
