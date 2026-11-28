import type { JobAction } from "@orc/core/job-actions";
import { type ReactElement, useId } from "react";
import { AgentRunAccessFields } from "@/components/AgentRunEditor";
import { HelpPopover } from "@/components/HelpPopover";
import { JobAgentPicker } from "@/components/JobAgentPicker";
import { MarkdownFormField } from "@/components/MarkdownFormField";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function jobActionValid(action: JobAction): boolean {
  if (action.type === "command") return Boolean(action.command.trim());
  if (action.type === "agent") return Boolean(action.prompt.trim() && action.agent.trim());
  return Boolean(action.title.trim());
}

export function JobActionFields({
  value,
  onChange,
  executionHost,
  cwd,
}: {
  value: JobAction;
  onChange: (action: JobAction) => void;
  executionHost?: string | null | undefined;
  cwd?: string | undefined;
}): ReactElement {
  const id = useId();
  return (
    <section className="space-y-3 border-y border-border py-4" data-testid="job-action-fields">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-type`}>What should this job do?</Label>
        <select
          id={`${id}-type`}
          data-testid="job-action-type"
          className="w-full min-h-8 rounded-md border border-control-border bg-background px-3 text-sm"
          value={value.type}
          onChange={(event) => {
            if (event.target.value === "command") onChange({ type: "command", command: "" });
            if (event.target.value === "agent")
              onChange({ type: "agent", agent: "codex-cli", prompt: "", permissions: "ask" });
            if (event.target.value === "task")
              onChange({ type: "task", title: "", body: "", start_automatically: false });
          }}
        >
          <option value="command">Run command</option>
          <option value="agent">Run agent</option>
          <option value="task">Create task</option>
        </select>
      </div>
      {value.type === "command" && (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-command`}>Command</Label>
          <Textarea
            id={`${id}-command`}
            aria-label="Command"
            data-testid="job-command-input"
            value={value.command}
            onChange={(event) => onChange({ ...value, command: event.target.value })}
            rows={3}
            placeholder="bun run build"
            required
          />
        </div>
      )}
      {value.type === "agent" && (
        <>
          <div className="space-y-1.5">
            <Label>Agent and model</Label>
            <div className="min-w-0">
              <JobAgentPicker value={value} onChange={onChange} host={executionHost} cwd={cwd} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-prompt`}>Instructions</Label>
            <Textarea
              id={`${id}-prompt`}
              data-testid="job-agent-prompt"
              value={value.prompt}
              onChange={(event) => onChange({ ...value, prompt: event.target.value })}
              required
              rows={4}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <AgentRunAccessFields
              value={value}
              onChange={(patch) => onChange({ ...value, ...patch })}
              testId="job-agent"
              help="Jobs run unattended: tool requests the permission level does not cover are denied. Read-only limits the agent to reading and searching."
            />
          </div>
        </>
      )}
      {value.type === "task" && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-title`}>Task title</Label>
            <Input
              id={`${id}-title`}
              data-testid="job-task-title"
              value={value.title}
              onChange={(event) => onChange({ ...value, title: event.target.value })}
              required
              maxLength={200}
            />
          </div>
          <MarkdownFormField
            label="Task instructions"
            id={`${id}-body`}
            data-testid="job-task-body"
            value={value.body}
            onChange={(body) => onChange({ ...value, body })}
            rows={4}
          />
          <div className="flex items-center gap-1">
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="job-task-autostart"
                checked={value.start_automatically}
                onChange={(event) =>
                  onChange({ ...value, start_automatically: event.target.checked })
                }
              />
              Start the task flow automatically
            </label>
            <HelpPopover label="Automatic task start" testId="job-task-autostart-help">
              Creates a task in this job's project. Automatic start is off by default; the task
              waits for a manual flow start.
            </HelpPopover>
          </div>
          {value.start_automatically && (
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-flow`}>Flow (blank uses the configured default)</Label>
              <Input
                id={`${id}-flow`}
                data-testid="job-task-flow"
                value={value.flow_name ?? ""}
                onChange={(event) =>
                  onChange({ ...value, flow_name: event.target.value || undefined })
                }
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
