import { ChatAgentOptionsSchema, chatRuntime } from "@orc/core/chat-options";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useChat } from "@/hooks/useChat";

export function ChatAgentOptionsEditor() {
  const { config, applyAgentOptions, thread, streaming } = useChat();
  const inputId = useId();
  const runtime = chatRuntime(config.agent);
  const saved = config.agentOptions[config.agent];
  const initial = JSON.stringify(
    saved?.runtime === "claude-sdk"
      ? saved.options
      : (saved?.args ?? (runtime === "claude-sdk" ? {} : [])),
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
        runtime === "claude-sdk"
          ? "Enter SDK options as a JSON object."
          : "Enter arguments as a JSON array of strings.",
      );
      return;
    }
    const parsed = ChatAgentOptionsSchema.safeParse(
      runtime === "claude-sdk" ? { runtime, options: raw } : { runtime, args: raw },
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
        threadId
          ? "Saved. Applies to your next message."
          : "Applies when you start this conversation.",
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
  return (
    <details data-testid="chat-agent-options" className="min-w-0 space-y-3 text-sm">
      <summary className="min-h-11 cursor-pointer py-3">Advanced launch options</summary>
      <label htmlFor={inputId} className="block space-y-2">
        <span>
          {runtime === "claude-sdk"
            ? "Claude SDK options (JSON)"
            : `${runtime === "codex" ? "Codex App Server" : "ACPX"} arguments (JSON array)`}
        </span>
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
      </label>
      <p className="text-xs text-muted-foreground" data-testid="chat-agent-options-help">
        {runtime === "claude-sdk"
          ? 'SDK fields: permissionMode, maxTurns, maxBudgetUsd, effort, thinking, fallbackModel, extraArgs. Example: {"maxTurns": 20, "effort": "high"}.'
          : runtime === "acpx"
            ? 'Example: ["--approve-all", "--timeout", "120"]. Other options include --approve-reads, --deny-all, --ttl and --non-interactive-permissions.'
            : "Use -c / --config for reasoning, verbosity, context, web_search or feature settings, or --enable / --disable. Set sandbox and approval behavior with Permissions above."}{" "}
        Options are kept separately for each agent. Credentials stay in host configuration.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          data-testid="chat-agent-options-example"
          disabled={streaming || pending}
          onClick={example}
        >
          {runtime === "codex" ? "High reasoning example" : "Bypass permissions example"}
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
