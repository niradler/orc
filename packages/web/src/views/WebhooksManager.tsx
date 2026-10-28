import { type ReactElement, useState } from "react";
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
    <div className="space-y-4">
      <ViewHeader
        title="Webhooks"
        compact
        meta={visibleHooks?.length ? visibleHooks.length : undefined}
        help="Configure each event source once, then connect it in Jobs. One webhook can trigger multiple jobs, each with its own event filters and action."
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
        <section className="grid min-h-[50dvh] place-items-center text-outline">
          <h2 className="text-sm font-normal">No webhooks configured</h2>
        </section>
      ) : (
        <section className="space-y-6">
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
