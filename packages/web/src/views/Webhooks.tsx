import { Copy, Plus, RotateCw, Trash2 } from "lucide-react";
import { useState } from "react";
import type { ManagedWebhook } from "@/api/client";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ViewHeader } from "@/components/ViewHeader";
import { useJobs } from "@/hooks/useJobs";
import { useProjectScope } from "@/hooks/useProjectScope";
import {
  useCreateWebhook,
  useDeleteWebhook,
  useRotateWebhook,
  useUpdateWebhook,
  useWebhookDeliveries,
  useWebhooks,
} from "@/hooks/useWebhooks";

const PR_EVENTS = "pull_request, pull_request_review, pull_request_review_comment";
const split = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export default function Webhooks({ projectId: savedProjectId }: { projectId: string }) {
  const projectId = useProjectScope(savedProjectId);
  const scope = projectId === "all" || projectId === "unassigned" ? undefined : projectId;
  const { data: hooks, error, refetch } = useWebhooks(scope);
  const { data: jobs } = useJobs({ project_id: scope, enabled: true });
  const create = useCreateWebhook();
  const update = useUpdateWebhook();
  const remove = useDeleteWebhook();
  const rotate = useRotateWebhook();
  const [selected, setSelected] = useState<string | null>(null);
  const { data: deliveries } = useWebhookDeliveries(selected);
  const [provider, setProvider] = useState<"generic" | "github">("github");
  const [name, setName] = useState("");
  const [jobId, setJobId] = useState("");
  const [events, setEvents] = useState(PR_EVENTS);
  const [actions, setActions] = useState("");
  const [revealed, setRevealed] = useState<{ secret: string; token?: string } | null>(null);
  const endpoint = (token: string) => `${window.location.origin}/webhooks/${token}`;
  const copy = (value: string) => navigator.clipboard.writeText(value);

  if (error)
    return (
      <>
        <ViewHeader title="Webhooks" />
        <ErrorState message={error.message} onRetry={() => refetch()} />
      </>
    );
  const mutationError = create.error ?? update.error ?? remove.error ?? rotate.error;
  return (
    <div className="space-y-8">
      <ViewHeader title="Webhooks" meta="Signed HTTP events → jobs" />
      <section className="border border-border rounded-sm p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Plus size={16} />
          <h2 className="font-medium">New endpoint</h2>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="hook-name">Name</Label>
            <Input id="hook-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="hook-provider">Provider</Label>
            <select
              id="hook-provider"
              className="w-full h-9 border border-border bg-background px-3 text-sm"
              value={provider}
              onChange={(e) => {
                const value = e.target.value as "generic" | "github";
                setProvider(value);
                setEvents(value === "github" ? PR_EVENTS : "");
              }}
            >
              <option value="generic">Generic HMAC</option>
              <option value="github">GitHub</option>
            </select>
          </div>
          <div>
            <Label htmlFor="hook-job">Job</Label>
            <select
              id="hook-job"
              className="w-full h-9 border border-border bg-background px-3 text-sm"
              value={jobId}
              onChange={(e) => setJobId(e.target.value)}
            >
              <option value="">Select an enabled job</option>
              {(jobs ?? []).map((job) => (
                <option key={job.id} value={job.id}>
                  {job.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="hook-events">Events (comma separated; blank = all)</Label>
            <Input id="hook-events" value={events} onChange={(e) => setEvents(e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <Label htmlFor="hook-actions">Payload actions (optional)</Label>
            <Input
              id="hook-actions"
              value={actions}
              onChange={(e) => setActions(e.target.value)}
              placeholder="opened, synchronize, submitted"
            />
          </div>
        </div>
        <Button
          disabled={!name.trim() || !jobId || create.isPending}
          onClick={() =>
            create.mutate(
              {
                name: name.trim(),
                provider,
                job_id: jobId,
                events: split(events),
                actions: split(actions),
              },
              {
                onSuccess: (hook) => {
                  setRevealed({ secret: hook.secret, token: hook.token });
                  setName("");
                  setJobId("");
                },
              },
            )
          }
        >
          Create webhook
        </Button>
        {revealed && (
          <div role="status" className="bg-surface-high p-3 space-y-2 text-sm">
            <p className="font-medium">Copy this signing secret now. It will not be shown again.</p>
            <div className="flex gap-2">
              <code className="break-all flex-1">{revealed.secret}</code>
              <Button size="icon" variant="ghost" onClick={() => copy(revealed.secret)}>
                <Copy />
              </Button>
            </div>
            {revealed.token && <code className="block break-all">{endpoint(revealed.token)}</code>}
          </div>
        )}
        {mutationError && (
          <p role="alert" className="text-error text-sm">
            {mutationError.message}
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">Endpoints</h2>
        {!hooks?.length ? (
          <EmptyState message="No webhooks configured" />
        ) : (
          hooks.map((hook) => (
            <article key={hook.id} className="border-b border-border py-4 space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className="font-medium hover:text-primary"
                  onClick={() => setSelected(hook.id)}
                >
                  {hook.name}
                </button>
                <span className="text-xs text-outline uppercase">{hook.provider}</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => update.mutate({ id: hook.id, enabled: !hook.enabled })}
                >
                  {hook.enabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  title="Rotate secret"
                  onClick={() =>
                    rotate.mutate(hook.id, {
                      onSuccess: (result) => setRevealed({ secret: result.secret }),
                    })
                  }
                >
                  <RotateCw />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  title="Delete"
                  onClick={() => {
                    if (window.confirm(`Delete ${hook.name}?`)) remove.mutate(hook.id);
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
              <div className="flex gap-2">
                <code className="text-xs break-all flex-1">{endpoint(hook.token)}</code>
                <Button size="icon" variant="ghost" onClick={() => copy(endpoint(hook.token))}>
                  <Copy />
                </Button>
              </div>
              <p className="text-xs text-outline">
                Events: {hook.events.join(", ") || "all"} · Actions:{" "}
                {hook.actions.join(", ") || "all"}
              </p>
              <Setup hook={hook} />
            </article>
          ))
        )}
      </section>

      {selected && (
        <section className="space-y-3">
          <h2 className="font-medium">Recent deliveries</h2>
          {!deliveries?.length ? (
            <EmptyState message="No deliveries received" />
          ) : (
            deliveries.map((item) => (
              <div
                key={item.id}
                className="grid gap-1 border-b border-border py-3 text-sm md:grid-cols-5"
              >
                <span>
                  {item.event}
                  {item.action ? ` / ${item.action}` : ""}
                </span>
                <span>{item.repository ?? "—"}</span>
                <span>{item.status}</span>
                <span className="text-outline">{new Date(item.created_at).toLocaleString()}</span>
                <span className="text-error">{item.error}</span>
              </div>
            ))
          )}
        </section>
      )}
    </div>
  );
}

function Setup({ hook }: { hook: ManagedWebhook }) {
  return hook.provider === "github" ? (
    <p className="text-xs text-outline">
      GitHub: JSON payload, secret above, and any configured events. ORC verifies
      X-Hub-Signature-256 and X-GitHub-Delivery.
    </p>
  ) : (
    <p className="text-xs text-outline">
      Generic: send JSON with X-Orc-Signature-256: sha256=&lt;HMAC of raw body&gt;. Optional
      X-Orc-Event and X-Orc-Delivery headers select and deduplicate deliveries.
    </p>
  );
}
