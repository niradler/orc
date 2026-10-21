import type { WebhookSubscription } from "@orc/core/job-actions";
import { type ReactElement, useId, useState } from "react";
import { Link } from "react-router-dom";
import { getApiUrl, type Job, type ManagedWebhook } from "@/api/client";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useUpdateJob } from "@/hooks/useJobs";
import {
  useCreateWebhook,
  useRotateWebhook,
  useUpdateWebhook,
  useWebhookDeliveries,
  useWebhooks,
} from "@/hooks/useWebhooks";
import { isLocalWebhookUrl, webhookFilters, webhookUrl } from "@/lib/webhook-setup";

function FilterInput({
  id,
  testId,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  testId: string;
  value: string[];
  onChange: (text: string) => void;
  placeholder: string;
}): ReactElement {
  const [draft, setDraft] = useState(value.join(", "));
  return (
    <Input
      id={id}
      data-testid={testId}
      value={draft}
      placeholder={placeholder}
      onChange={(event) => {
        setDraft(event.target.value);
        onChange(event.target.value);
      }}
    />
  );
}

export function WebhookCreate({
  projectId,
  onCreated,
}: {
  projectId?: string;
  onCreated?: (hook: ManagedWebhook) => void;
}): ReactElement {
  const create = useCreateWebhook();
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<"github" | "generic">("github");
  const [revealed, setRevealed] = useState<(ManagedWebhook & { secret: string }) | null>(null);
  const id = useId();
  if (revealed)
    return (
      <div data-testid="webhook-created" className="space-y-3">
        <WebhookSetup hook={revealed} secret={revealed.secret} />
        <Button
          type="button"
          variant="outline"
          data-testid="webhook-setup-done"
          onClick={() => {
            onCreated?.(revealed);
            setRevealed(null);
            setName("");
          }}
        >
          I've copied the setup details
        </Button>
      </div>
    );
  return (
    <div className="space-y-3" data-testid="webhook-create-form">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-name`}>Webhook name</Label>
        <Input
          id={`${id}-name`}
          data-testid="webhook-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={100}
          placeholder="GitHub repository events"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-provider`}>Provider</Label>
        <select
          id={`${id}-provider`}
          data-testid="webhook-provider"
          className="w-full min-h-11 rounded-md border border-control-border bg-background px-3 text-sm"
          value={provider}
          onChange={(event) => setProvider(event.target.value as typeof provider)}
        >
          <option value="github">GitHub</option>
          <option value="generic">Other service (HMAC)</option>
        </select>
      </div>
      <p className="text-xs text-outline">
        Create the event source here. Connect jobs and choose their event filters in Jobs. No job is
        required to create a webhook.
      </p>
      {create.error && (
        <p role="alert" className="text-sm text-error">
          {create.error.message}
        </p>
      )}
      <Button
        type="button"
        data-testid="webhook-create"
        disabled={!name.trim() || create.isPending}
        onClick={() =>
          create.mutate(
            { name: name.trim(), provider, project_id: projectId ?? null },
            { onSuccess: setRevealed },
          )
        }
      >
        {create.isPending ? "Creating..." : "Create webhook"}
      </Button>
    </div>
  );
}

export function WebhookPicker({
  value,
  onChange,
  projectId,
}: {
  value: WebhookSubscription[];
  onChange: (value: WebhookSubscription[]) => void;
  projectId?: string;
}): ReactElement {
  const { data: sources, error, isLoading, refetch } = useWebhooks(projectId);
  const hooks = sources?.filter(
    (hook) => hook.project_id === null || hook.project_id === projectId,
  );
  const [creating, setCreating] = useState(false);
  function connect(id: string): void {
    if (!value.some((item) => item.webhook_id === id))
      onChange([...value, { webhook_id: id, events: [], actions: [] }]);
  }
  function edit(id: string, field: "events" | "actions", text: string): void {
    onChange(
      value.map((binding) =>
        binding.webhook_id === id ? { ...binding, [field]: webhookFilters(text) } : binding,
      ),
    );
  }
  return (
    <section className="space-y-3 border-y border-border py-4" data-testid="job-webhook-picker">
      <h3 className="text-sm font-medium">Which webhook should trigger this job?</h3>
      {error ? (
        <ErrorState message={error.message} onRetry={() => refetch()} />
      ) : (
        <>
          <Label htmlFor="job-webhook-source">Configured webhooks</Label>
          <select
            id="job-webhook-source"
            data-testid="job-webhook-select"
            className="w-full min-h-11 rounded-md border border-control-border bg-background px-3 text-sm"
            value=""
            disabled={isLoading}
            onChange={(event) => {
              if (event.target.value) connect(event.target.value);
            }}
          >
            <option value="">
              {isLoading ? "Loading webhooks..." : "Select an existing webhook"}
            </option>
            {(hooks ?? [])
              .filter((hook) => !value.some((binding) => binding.webhook_id === hook.id))
              .map((hook) => (
                <option key={hook.id} value={hook.id}>
                  {hook.name}
                  {hook.enabled ? "" : " (disabled)"}
                </option>
              ))}
          </select>
          {!isLoading && !hooks?.length && (
            <p className="text-xs text-outline">
              No webhooks configured for this project yet. Create one below or on the Webhooks page.
            </p>
          )}
        </>
      )}
      {value.map((binding) => (
        <div
          key={binding.webhook_id}
          className="space-y-2 border-t border-border pt-3"
          data-testid="job-webhook-binding"
          data-webhook-id={binding.webhook_id}
        >
          <div className="flex justify-between gap-2">
            <span className="text-sm font-medium">
              {hooks?.find((hook) => hook.id === binding.webhook_id)?.name ?? binding.webhook_id}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="job-webhook-remove"
              onClick={() =>
                onChange(value.filter((item) => item.webhook_id !== binding.webhook_id))
              }
            >
              Disconnect
            </Button>
          </div>
          <Label htmlFor={`events-${binding.webhook_id}`}>Events for this job</Label>
          <FilterInput
            id={`events-${binding.webhook_id}`}
            testId="webhook-events"
            value={binding.events}
            onChange={(text) => edit(binding.webhook_id, "events", text)}
            placeholder="pull_request, push (blank accepts all)"
          />
          <Label htmlFor={`actions-${binding.webhook_id}`}>Actions for this job (optional)</Label>
          <FilterInput
            id={`actions-${binding.webhook_id}`}
            testId="webhook-actions"
            value={binding.actions}
            onChange={(text) => edit(binding.webhook_id, "actions", text)}
            placeholder="opened, synchronize (blank accepts all)"
          />
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="webhook-add"
        onClick={() => setCreating(!creating)}
      >
        {creating ? "Close new webhook" : "Create a webhook"}
      </Button>
      {creating && (
        <WebhookCreate
          projectId={projectId}
          onCreated={(hook) => {
            connect(hook.id);
            setCreating(false);
          }}
        />
      )}
    </section>
  );
}

export function JobWebhooks({ job }: { job: Job }): ReactElement {
  const update = useUpdateJob();
  const [bindings, setBindings] = useState<WebhookSubscription[]>(job.webhooks ?? []);
  return (
    <section className="space-y-3" data-testid="job-webhooks">
      {!job.enabled && (
        <p className="text-sm text-outline">
          Job disabled. Configure connections now and enable it from Jobs when ready.
        </p>
      )}
      <WebhookPicker
        value={bindings}
        onChange={setBindings}
        projectId={job.project_id ?? undefined}
      />
      {update.error && (
        <p role="alert" className="text-sm text-error">
          {update.error.message}
        </p>
      )}
      <Button
        type="button"
        size="sm"
        data-testid="job-webhooks-save"
        disabled={update.isPending}
        onClick={() => update.mutate({ id: job.id, webhooks: bindings, trigger_type: "webhook" })}
      >
        Save connections
      </Button>
      {update.isSuccess && (
        <p role="status" className="text-xs text-outline">
          Connections saved.
        </p>
      )}
      <Link
        className="inline-block text-sm underline"
        to={`/webhooks?project=${encodeURIComponent(job.project_id ?? "all")}`}
      >
        Manage configured webhooks and deliveries
      </Link>
    </section>
  );
}

function CopyValue({
  label,
  value,
  secret = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return (
    <div className="space-y-1">
      <p className="text-xs text-outline">{label}</p>
      <div className="flex items-start gap-2">
        <code
          className="min-w-0 flex-1 break-all text-xs"
          data-testid={secret ? "webhook-secret" : "webhook-url"}
        >
          {value}
        </code>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={`Copy ${label}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setError(false);
            } catch {
              setError(true);
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-error">
          Select and copy the value above; clipboard access is unavailable.
        </p>
      )}
    </div>
  );
}

export function WebhookSetup({
  hook,
  secret,
}: {
  hook: ManagedWebhook;
  secret?: string;
}): ReactElement {
  const url = webhookUrl(hook.token, getApiUrl(), window.location.origin);
  return (
    <div className="space-y-3" data-testid="webhook-setup">
      <CopyValue label="Payload URL" value={url} />
      {isLocalWebhookUrl(url) && (
        <p className="text-sm text-warning">
          This address is local. For external providers, use your publicly reachable ORC address
          with the same /webhooks/ path.
        </p>
      )}
      {secret ? (
        <>
          <CopyValue label="Signing secret" value={secret} secret />
          <p className="text-xs text-outline">
            Copy the signing secret before leaving. It is shown once.
          </p>
        </>
      ) : (
        <p className="text-xs text-outline">
          The signing secret is hidden. Generate a replacement only if you need to reconnect the
          sender.
        </p>
      )}
      {hook.provider === "github" ? (
        <ol className="list-decimal space-y-1 pl-5 text-sm text-outline">
          <li>In your repository, open GitHub Settings - Webhooks - Add webhook.</li>
          <li>Paste the Payload URL, select application/json, and enter the signing secret.</li>
          <li>Select the events needed by your connected jobs. Each job has its own filters.</li>
          <li>Send an event and inspect Recent deliveries below.</li>
        </ol>
      ) : (
        <p className="text-sm text-outline">
          Send JSON, signed with HMAC-SHA256 of the raw body. Set X-Orc-Signature-256 to
          sha256=&lt;hex signature&gt;, X-Orc-Event to the event name and X-Orc-Delivery to a unique
          delivery ID.
        </p>
      )}
    </div>
  );
}

export function WebhookEndpoint({ hook }: { hook: ManagedWebhook }): ReactElement {
  const update = useUpdateWebhook();
  const rotate = useRotateWebhook();
  const [showDeliveries, setShowDeliveries] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [secret, setSecret] = useState<string | undefined>();
  return (
    <article
      className="space-y-3 border-b border-border pb-5"
      data-testid="webhook-endpoint"
      data-webhook-id={hook.id}
    >
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-medium">{hook.name}</h3>
        <span className="text-xs text-outline">
          {hook.provider} - {hook.enabled ? "Enabled" : "Disabled"}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={update.isPending}
          onClick={() => update.mutate({ id: hook.id, enabled: !hook.enabled })}
        >
          {hook.enabled ? "Disable" : "Enable"}
        </Button>
      </div>
      <div className="space-y-1" data-testid="webhook-connected-jobs">
        <p className="text-xs text-outline">Connected jobs ({hook.subscriptions.length})</p>
        {hook.subscriptions.length ? (
          hook.subscriptions.map((binding) => (
            <div key={binding.job_id} className="text-sm">
              <Link
                className="underline"
                data-testid="webhook-job-link"
                to={`/jobs/${binding.job_id}?project=all`}
              >
                {binding.name}
              </Link>
              <span className="text-xs text-outline">
                {" "}
                - {binding.enabled ? "Enabled" : "Disabled"}; events:{" "}
                {binding.events.join(", ") || "all"}; actions: {binding.actions.join(", ") || "all"}
              </span>
            </div>
          ))
        ) : (
          <p className="text-sm text-outline">
            No connected jobs. Select this webhook when creating or editing a job.
          </p>
        )}
      </div>
      <WebhookSetup hook={hook} secret={secret} />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="webhook-deliveries-toggle"
          onClick={() => setShowDeliveries(!showDeliveries)}
        >
          {showDeliveries ? "Hide deliveries" : "Recent deliveries"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setRotating(!rotating)}>
          New signing secret
        </Button>
      </div>
      {rotating && (
        <div className="space-y-2 text-sm">
          <p>
            The sender's existing secret will stop working. Update it after generating the
            replacement.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={rotate.isPending}
            onClick={() =>
              rotate.mutate(hook.id, {
                onSuccess: (result) => {
                  setSecret(result.secret);
                  setRotating(false);
                },
              })
            }
          >
            Generate replacement secret
          </Button>
        </div>
      )}
      {(update.error || rotate.error) && (
        <p role="alert" className="text-sm text-error">
          {(update.error ?? rotate.error)?.message}
        </p>
      )}
      {showDeliveries && <WebhookDeliveries id={hook.id} />}
    </article>
  );
}

function WebhookDeliveries({ id }: { id: string }): ReactElement {
  const { data, isLoading, error, refetch } = useWebhookDeliveries(id);
  return (
    <section className="space-y-2" data-testid="webhook-deliveries">
      <h4 className="text-sm font-medium">Recent deliveries</h4>
      {error ? (
        <ErrorState message={error.message} onRetry={() => refetch()} />
      ) : isLoading ? (
        <p role="status">Loading deliveries...</p>
      ) : !data?.length ? (
        <p className="text-sm text-outline">
          No events received yet. Register the endpoint with your provider, then send an event.
        </p>
      ) : (
        data.map((delivery) => (
          <div
            key={delivery.id}
            className="space-y-1 border-t border-border py-2 text-xs"
            data-testid="webhook-delivery"
          >
            <div className="flex flex-wrap justify-between gap-2">
              <span>
                {delivery.event}
                {delivery.action ? ` / ${delivery.action}` : ""}
              </span>
              <span>{delivery.status}</span>
            </div>
            <p className="text-outline">
              {delivery.repository} {new Date(delivery.created_at).toLocaleString()}
            </p>
            {delivery.status === "ignored" && (
              <p className="text-outline">No enabled connected job matched this event.</p>
            )}
            {delivery.error && <p className="text-error">{delivery.error}</p>}
            {delivery.runs.map((run) => (
              <div key={run.job_run_id} className="flex flex-wrap gap-3">
                <Link className="underline" to={`/jobs/${run.job_id}?project=all`}>
                  Job run: {run.status}
                </Link>
                {run.task_id && (
                  <Link className="underline" to={`/tasks/${run.task_id}?project=all`}>
                    Created task
                  </Link>
                )}
                {run.session_id && (
                  <Link className="underline" to={`/audit/${run.session_id}?project=all`}>
                    Agent session
                  </Link>
                )}
              </div>
            ))}
          </div>
        ))
      )}
    </section>
  );
}
