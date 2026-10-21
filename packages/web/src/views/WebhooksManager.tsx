import { type ReactElement, useState } from "react";
import { Link } from "react-router-dom";
import { ErrorState } from "@/components/ErrorState";
import { WebhookCreate, WebhookEndpoint } from "@/components/JobWebhooks";
import { Button } from "@/components/ui/button";
import { ViewHeader } from "@/components/ViewHeader";
import { useProjectScope } from "@/hooks/useProjectScope";
import { useDeleteWebhook, useWebhooks } from "@/hooks/useWebhooks";

export default function WebhooksManager({
  projectId: savedProjectId,
}: {
  projectId: string;
}): ReactElement {
  const projectId = useProjectScope(savedProjectId);
  const scope = projectId === "all" || projectId === "unassigned" ? undefined : projectId;
  const { data: hooks, error, isLoading, refetch } = useWebhooks(scope);
  const remove = useDeleteWebhook();
  const [adding, setAdding] = useState(false);
  const visibleHooks = hooks?.filter(
    (hook) => projectId !== "unassigned" || hook.project_id === null,
  );
  return (
    <div className="space-y-6">
      <ViewHeader
        title="Webhooks"
        meta="Configured event sources and connected jobs"
        action={
          <Button
            type="button"
            size="sm"
            data-testid="new-webhook-button"
            onClick={() => setAdding(!adding)}
          >
            {adding ? "Close new webhook" : "Create webhook"}
          </Button>
        }
      />
      <p className="text-sm text-outline">
        Configure each event source once, then select it in Jobs. One webhook can trigger multiple
        jobs, each with its own event filters and action.
      </p>
      {adding && (
        <section className="space-y-4 border-y border-border py-4">
          <h2 className="text-sm font-medium">New webhook</h2>
          <p className="text-xs text-outline">
            {scope
              ? "This webhook belongs to the selected project."
              : "This webhook will be shared across projects. Select a project in the workspace to scope it."}
          </p>
          <WebhookCreate projectId={scope} onCreated={() => setAdding(false)} />
        </section>
      )}
      {error ? (
        <ErrorState message={error.message} onRetry={() => refetch()} />
      ) : isLoading ? (
        <p role="status">Loading webhooks...</p>
      ) : !visibleHooks?.length ? (
        <section className="space-y-3 border-t border-border py-6">
          <h2 className="text-sm font-medium">No webhooks configured</h2>
          <p className="text-sm text-outline">
            Create a webhook above, register its URL and secret with your provider, then select it
            when creating a job.
          </p>
          <Link
            className="inline-block text-sm underline"
            to={`/jobs?project=${encodeURIComponent(projectId)}`}
            data-testid="webhooks-go-jobs"
          >
            Open Jobs
          </Link>
        </section>
      ) : (
        <section className="space-y-6">
          <h2 className="text-sm font-medium">Configured webhooks ({visibleHooks.length})</h2>
          {visibleHooks.map((hook) => (
            <div key={hook.id} className="space-y-2">
              <WebhookEndpoint hook={hook} />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={remove.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete ${hook.name}? Connected jobs will stop receiving events from this endpoint.`,
                    )
                  )
                    remove.mutate(hook.id);
                }}
              >
                Delete webhook
              </Button>
            </div>
          ))}
        </section>
      )}
      {remove.error && (
        <p role="alert" className="text-sm text-error">
          {remove.error.message}
        </p>
      )}
    </div>
  );
}
