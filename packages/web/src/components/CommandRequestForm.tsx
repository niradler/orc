import type { HumanRequest } from "@orc/core/human-requests";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { ApiError, api } from "@/api/client";
import { HelpPopover } from "@/components/HelpPopover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  COMMAND_ARGUMENT_MANUAL,
  commandArgumentFromPicker,
  commandArgumentPickerValue,
} from "@/lib/secret-ui";

export type CommandRequestDraft = {
  script: string;
  editing: boolean;
  values: Record<string, string>;
};

export function CommandRequestForm({
  request,
  actions,
  draft,
  onDraftChange,
}: {
  request: HumanRequest;
  actions?: ReactNode;
  draft?: CommandRequestDraft;
  onDraftChange?: (update: Partial<CommandRequestDraft>) => void;
}) {
  const spec = request.input.command;
  const projectId = request.input.project_id;
  const secretsQuery = useQuery({
    queryKey: ["project-secrets", projectId],
    queryFn: () => api.projectSecrets.list(projectId ?? ""),
    enabled: Boolean(projectId),
  });
  const savedSecrets = secretsQuery.data?.secrets ?? [];
  const [localDraft, setLocalDraft] = useState<CommandRequestDraft>({
    script:
      request.response?.kind === "command"
        ? (request.response.script ?? spec?.script ?? "")
        : (spec?.script ?? ""),
    editing: false,
    values: {},
  });
  const { script, editing, values } = draft ?? localDraft;
  const updateDraft = (update: Partial<CommandRequestDraft>) =>
    onDraftChange ? onDraftChange(update) : setLocalDraft((current) => ({ ...current, ...update }));
  const setScript = (script: string) => updateDraft({ script });
  const setEditing = (editing: boolean) => updateDraft({ editing });
  const setValues = (
    update: Record<string, string> | ((previous: Record<string, string>) => Record<string, string>),
  ) => updateDraft({ values: typeof update === "function" ? update(values) : update });
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
  // Without a project nothing resolves (the Run fails closed), so the note must
  // not claim secrets will be injected.
  const injectedSecrets = projectId
    ? spec.arguments.filter(
        (arg) =>
          arg.allow_secret_ref &&
          commandArgumentPickerValue(values[arg.name] ?? "") !== COMMAND_ARGUMENT_MANUAL,
      ).length
    : 0;
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
            spec.arguments.map((arg) => {
              const value = values[arg.name] ?? "";
              const canPick = Boolean(arg.allow_secret_ref) && savedSecrets.length > 0;
              const isSavedRef = commandArgumentPickerValue(value) !== COMMAND_ARGUMENT_MANUAL;
              const refWithoutProject = Boolean(arg.allow_secret_ref) && !projectId && isSavedRef;
              const inputId = `argument-${request.id}-${arg.name}`;
              return (
                <div className="block min-w-0 space-y-1 text-xs" key={arg.name}>
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <label htmlFor={inputId}>
                      {arg.label}
                      {!arg.required ? " (optional)" : ""}
                    </label>
                    <code
                      data-testid={`attention-argument-name-${arg.name}`}
                      className="break-all font-mono text-xs text-muted-foreground"
                    >
                      {`ORC_INPUT_${arg.name}`}
                    </code>
                  </span>
                  {canPick && (
                    <Select
                      value={commandArgumentPickerValue(value)}
                      onValueChange={(next) =>
                        setValues((previous) => ({
                          ...previous,
                          [arg.name]: commandArgumentFromPicker(next),
                        }))
                      }
                    >
                      <SelectTrigger
                        data-testid={`attention-argument-secret-${arg.name}`}
                        aria-label={`Use a saved secret for ${arg.label}`}
                        className="min-h-11 w-full sm:min-h-8 [@media(pointer:coarse)]:min-h-11"
                      >
                        <SelectValue placeholder="Use a saved secret" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={COMMAND_ARGUMENT_MANUAL}>Type a value</SelectItem>
                        {savedSecrets.map((secret) => (
                          <SelectItem key={secret.reference} value={secret.reference}>
                            {secret.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {canPick && isSavedRef ? (
                    <p
                      data-testid={`attention-argument-ref-${arg.name}`}
                      className="wrap-anywhere rounded-sm bg-surface px-2 py-1.5 font-mono text-xs text-muted-foreground"
                    >
                      {value}
                    </p>
                  ) : (
                    <Input
                      id={inputId}
                      type={arg.allow_secret_ref ? "password" : "text"}
                      autoComplete="off"
                      data-testid={`attention-argument-${arg.name}`}
                      value={value}
                      required={arg.required}
                      maxLength={16000}
                      aria-describedby={
                        arg.description ? `argument-help-${request.id}-${arg.name}` : undefined
                      }
                      onChange={(event) =>
                        setValues((previous) => ({ ...previous, [arg.name]: event.target.value }))
                      }
                    />
                  )}
                  {refWithoutProject && (
                    <span
                      data-testid={`attention-argument-noproject-${arg.name}`}
                      className="block text-warning"
                    >
                      This looks like a secret reference, but the request has no project to resolve
                      it.
                    </span>
                  )}
                  {arg.description && (
                    <span
                      id={`argument-help-${request.id}-${arg.name}`}
                      className="block text-muted-foreground"
                    >
                      {arg.description}
                    </span>
                  )}
                </div>
              );
            })}
        </div>
        {pending && injectedSecrets > 0 && (
          <p
            data-testid="attention-secret-injection-note"
            className="text-xs text-muted-foreground"
          >
            This run injects {injectedSecrets} saved secret{injectedSecrets > 1 ? "s" : ""} into the
            command as environment variable{injectedSecrets > 1 ? "s" : ""}.
          </p>
        )}
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
              Only arguments the agent opted in offer saved project secrets and mask the typed
              value; every other argument stays plain and keeps exactly what you type. Submitted
              values are used only for this run and redacted from its output. The agent receives the
              result without the raw inputs.
            </HelpPopover>
          </div>
        )}
        {run.error && (
          <p role="alert">
            {run.error instanceof ApiError && run.error.status < 500
              ? run.error.message
              : `${run.error.message}. Could not confirm completion. Refresh the request before trying again.`}
          </p>
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
