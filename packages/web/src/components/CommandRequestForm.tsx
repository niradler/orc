import type { HumanRequest } from "@orc/core/human-requests";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function CommandRequestForm({ request }: { request: HumanRequest }) {
  const spec = request.input.command;
  const [script, setScript] = useState(
    request.response?.kind === "command"
      ? (request.response.script ?? spec?.script ?? "")
      : (spec?.script ?? ""),
  );
  const [values, setValues] = useState<Record<string, string>>({});
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
    <div className="space-y-3">
      <p className="text-sm break-all">
        Host: {spec.host ?? "API host"} · Folder: {spec.cwd}
      </p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) run.mutate();
        }}
      >
        <label htmlFor={`command-${request.id}`} className="block text-sm space-y-2">
          <span>Command</span>
          <Textarea
            id={`command-${request.id}`}
            data-testid="attention-command"
            value={
              request.response?.kind === "command" ? (request.response.script ?? script) : script
            }
            onChange={(event) => setScript(event.target.value)}
            disabled={!pending}
            maxLength={16000}
            className="font-mono"
          />
        </label>
        {pending &&
          spec.arguments.map((arg) => (
            <label
              htmlFor={`argument-${request.id}-${arg.name}`}
              className="block text-sm space-y-2"
              key={arg.name}
            >
              <span>
                {arg.label}
                {arg.required ? " (required)" : ""}
              </span>
              <Input
                id={`argument-${request.id}-${arg.name}`}
                type="password"
                autoComplete="off"
                data-testid={`attention-argument-${arg.name}`}
                value={values[arg.name] ?? ""}
                required={arg.required}
                maxLength={16000}
                onChange={(event) =>
                  setValues((previous) => ({ ...previous, [arg.name]: event.target.value }))
                }
              />
            </label>
          ))}
        {pending && (
          <p className="text-xs text-outline">
            Values are hidden and used only for this run. Supplied values are redacted from the
            result.
          </p>
        )}
        {(pending || run.isPending || request.status === "running") && (
          <Button
            data-testid="attention-run"
            type="submit"
            disabled={
              !pending ||
              !script.trim() ||
              spec.arguments.some((arg) => arg.required && !values[arg.name])
            }
          >
            {run.isPending || request.status === "running" ? "Running…" : "Run command"}
          </Button>
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
