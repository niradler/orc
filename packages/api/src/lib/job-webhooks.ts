import { ValidationError } from "@orc/core/errors";
import type { WebhookSubscription } from "@orc/core/job-actions";
import { getSqlite } from "@orc/db/client";

export function validateJobWebhooks(
  bindings: WebhookSubscription[],
  projectId: string | null,
): void {
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (seen.has(binding.webhook_id)) throw new ValidationError("Select each webhook only once");
    seen.add(binding.webhook_id);
    const hook = getSqlite()
      .query<{ project_id: string | null }, [string]>("SELECT project_id FROM webhooks WHERE id=?")
      .get(binding.webhook_id);
    if (!hook) throw new ValidationError("Selected webhook does not exist");
    if (hook.project_id !== null && hook.project_id !== projectId)
      throw new ValidationError("Selected webhook belongs to another project");
  }
}

export function saveJobWebhooks(jobId: string, bindings: WebhookSubscription[]): void {
  const sqlite = getSqlite();
  sqlite.query("DELETE FROM webhook_subscriptions WHERE job_id=?").run(jobId);
  for (const binding of bindings)
    sqlite
      .query("INSERT INTO webhook_subscriptions(webhook_id,job_id,events,actions) VALUES(?,?,?,?)")
      .run(
        binding.webhook_id,
        jobId,
        JSON.stringify([...new Set(binding.events)]),
        JSON.stringify([...new Set(binding.actions)]),
      );
}

export function readJobWebhooks(jobId: string): WebhookSubscription[] {
  return getSqlite()
    .query<{ webhook_id: string; events: string; actions: string }, [string]>(
      "SELECT webhook_id,events,actions FROM webhook_subscriptions WHERE job_id=?",
    )
    .all(jobId)
    .map((row) => ({
      webhook_id: row.webhook_id,
      events: JSON.parse(row.events),
      actions: JSON.parse(row.actions),
    }));
}
