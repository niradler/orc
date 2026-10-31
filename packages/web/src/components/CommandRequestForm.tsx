import type { HumanRequest } from "@orc/core/human-requests";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { api } from "@/api/client";
import { HelpPopover } from "@/components/HelpPopover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function CommandRequestForm({
  request,
  actions,
}: {
  request: HumanRequest;
  actions?: ReactNode;
}) {
  const spec = request.input.command;
  const [script, setScript] = useState(
    request.response?.kind === "command"
      ? (request.response.script ?? spec?.script ?? "")
      : (spec?.script ?? ""),
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const client = useQueryClient();
  const run = useMutation({
    mutationFn: async () => {
      const submitted = values;
      setValues({});
      return api.humanRequests.run(request.id, request.version, script, submitted);
    },
    onSettled: () => client.invalidateQueries({ queryKey: ["human-requests"] }),
  });
  if (!spec) return null;
  const pending = request.status === "pending" && !run.isPending;
  return (
    <div className="space-y-2">
      <dl className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <div className="flex min-w-0 gap-1">
          <dt>Host:</dt>
          <dd className="wrap-anywhere">{spec.host ?? "Local"}</dd>
        </div>
        <div className="flex min-w-0 gap-1">
          <dt>Folder:</dt>
          <dd className="wrap-anywhere">{spec.cwd}</dd>
        </div>
      </dl>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) run.mutate();
        }}
      >
        <div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium">Command to run</span>
            {pending && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid="attention-edit-command"
                aria-expanded={editing}
                aria-controls={`command-${request.id}`}
                onClick={() => setEditing(!editing)}
              >
                {editing ? "Done editing" : "Edit command"}
              </Button>
            )}
          </div>
          {editing && pending ? (
            <label htmlFor={`command-${request.id}`} className="block">
              <span className="sr-only">Command to run</span>
              <Textarea
                id={`command-${request.id}`}
                data-testid="attention-command"
                value={
                  request.response?.kind === "command"
                    ? (request.response.script ?? script)
                    : script
                }
                onChange={(event) => setScript(event.target.value)}
                disabled={!pending}
                maxLength={16000}
                className="min-h-20 font-mono text-xs"
              />
            </label>
          ) : (
            <section
              aria-label="Command to run"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: long command previews must be keyboard-scrollable before running.
              tabIndex={0}
              data-testid="attention-command-preview"
              className="max-h-40 overflow-auto rounded-sm bg-surface px-2 py-1.5 focus-visible:outline-2 focus-visible:outline-focus"
            >
              <pre className="whitespace-pre-wrap wrap-anywhere font-mono text-xs">
                {request.response?.kind === "command"
                  ? (request.response.script ?? script)
                  : script}
              </pre>
            </section>
          )}
        </div>
        <div className="grid gap-x-3 gap-y-2 sm:grid-cols-2">
          {pending &&
            spec.arguments.map((arg) => (
              <label
                htmlFor={`argument-${request.id}-${arg.name}`}
                className="block min-w-0 space-y-1 text-xs"
                key={arg.name}
              >
                <span>
                  {arg.label}
                  {!arg.required ? " (optional)" : ""}
                </span>
                <Input
                  id={`argument-${request.id}-${arg.name}`}
                  type="password"
                  autoComplete="off"
                  data-testid={`attention-argument-${arg.name}`}
                  value={values[arg.name] ?? ""}
                  required={arg.required}
                  maxLength={16000}
                  aria-describedby={
                    arg.description ? `argument-help-${request.id}-${arg.name}` : undefined
                  }
                  onChange={(event) =>
                    setValues((previous) => ({ ...previous, [arg.name]: event.target.value }))
                  }
                />
                {arg.description && (
                  <span
                    id={`argument-help-${request.id}-${arg.name}`}
                    className="block text-muted-foreground"
                  >
                    {arg.description}
                  </span>
                )}
              </label>
            ))}
        </div>
        {(pending || run.isPending || request.status === "running") && (
          <div className="flex flex-wrap items-center gap-1">
            <Button
              data-testid="attention-run"
              type="submit"
              size="sm"
              disabled={
                !pending ||
                !script.trim() ||
                spec.arguments.some((arg) => arg.required && !values[arg.name])
              }
            >
              {run.isPending || request.status === "running" ? "Running…" : "Run command"}
            </Button>
            {pending && actions}
            <HelpPopover label="Secure input handling" testId="attention-input-help">
              All entered values are used only for this run and redacted from its output. The agent
              receives the result without the raw inputs.
            </HelpPopover>
          </div>
        )}
        {run.error && (
          <p role="alert">Could not confirm completion. Refresh the request before trying again.</p>
        )}
      </form>
      {request.response?.kind === "command" && (
        <div data-testid="attention-command-result" className="space-y-2">
          <p>Exit code: {request.response.exit_code}</p>
          <pre className="whitespace-pre-wrap break-all text-xs">
            {request.response.stdout}
            {request.response.stderr}
          </pre>
          {request.response.truncated && <p>Output was truncated.</p>}
        </div>
      )}
    </div>
  );
}
