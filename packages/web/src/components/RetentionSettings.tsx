import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { HelpPopover } from "@/components/HelpPopover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function RetentionSettings() {
  const client = useQueryClient();
  const preferences = useQuery({ queryKey: ["workspace-preferences"], queryFn: api.settings.get });
  const [notifications, setNotifications] = useState<string | null>(null);
  const [audit, setAudit] = useState<string | null>(null);
  const [jobHistory, setJobHistory] = useState<string | null>(null);
  const [requests, setRequests] = useState<string | null>(null);
  const [sizeLimit, setSizeLimit] = useState<string | null>(null);
  const [sizeAction, setSizeAction] = useState<"warn" | "prune" | null>(null);
  const notificationDays =
    notifications ?? String(preferences.data?.notification_retention_days ?? 30);
  const auditDays = audit ?? String(preferences.data?.audit_retention_days ?? 90);
  const jobHistoryDays = jobHistory ?? String(preferences.data?.job_history_retention_days ?? 90);
  const requestDays = requests ?? String(preferences.data?.request_retention_days ?? 7);
  const sizeLimitMb = sizeLimit ?? String(preferences.data?.database_size_limit_mb ?? 500);
  const sizeActionValue = sizeAction ?? preferences.data?.database_size_action ?? "warn";
  const save = useMutation({
    mutationFn: () =>
      api.settings.save({
        notification_retention_days: Number(notificationDays),
        audit_retention_days: Number(auditDays),
        job_history_retention_days: Number(jobHistoryDays),
        request_retention_days: Number(requestDays),
        database_size_limit_mb: Number(sizeLimitMb),
        database_size_action: sizeActionValue,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["workspace-preferences"] });
      await client.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
  return (
    <section className="space-y-3" aria-labelledby="retention-title">
      <div className="flex items-center gap-1">
        <h3 id="retention-title" className="text-sm font-medium">
          Automatic cleanup
        </h3>
        <HelpPopover label="automatic cleanup" testId="retention-help">
          Notifications expire even when unresolved; their requests are kept. Audit uses its own
          expiry. Job history: finished jobs, flows and stopped bridge sessions. Request history:
          answered questions, approvals and MCP tasks. Over the size limit ORC warns or prunes
          terminal history; pads, tasks, knowledge and memories are never deleted.
        </HelpPopover>
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="notification-retention-days">Notifications (days)</Label>
          <Input
            id="notification-retention-days"
            data-testid="notification-retention-days"
            type="number"
            min={1}
            max={3650}
            step={1}
            required
            value={notificationDays}
            onChange={(event) => {
              setNotifications(event.target.value);
              save.reset();
            }}
            className="w-32"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="audit-retention-days">Audit log (days)</Label>
          <Input
            id="audit-retention-days"
            data-testid="audit-retention-days"
            type="number"
            min={1}
            max={3650}
            step={1}
            required
            value={auditDays}
            onChange={(event) => {
              setAudit(event.target.value);
              save.reset();
            }}
            className="w-32"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="job-history-retention-days">Job &amp; flow history (days)</Label>
          <Input
            id="job-history-retention-days"
            data-testid="job-history-retention-days"
            type="number"
            min={1}
            max={3650}
            step={1}
            required
            value={jobHistoryDays}
            onChange={(event) => {
              setJobHistory(event.target.value);
              save.reset();
            }}
            className="w-32"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="request-retention-days">Questions, approvals &amp; MCP (days)</Label>
          <Input
            id="request-retention-days"
            data-testid="request-retention-days"
            type="number"
            min={1}
            max={3650}
            step={1}
            required
            value={requestDays}
            onChange={(event) => {
              setRequests(event.target.value);
              save.reset();
            }}
            className="w-32"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="database-size-limit-mb">Database size limit (MB)</Label>
          <Input
            id="database-size-limit-mb"
            data-testid="database-size-limit-mb"
            type="number"
            min={0}
            max={1000000}
            step={1}
            required
            value={sizeLimitMb}
            onChange={(event) => {
              setSizeLimit(event.target.value);
              save.reset();
            }}
            className="w-32"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="database-size-action">When over the limit</Label>
          <select
            id="database-size-action"
            data-testid="database-size-action"
            value={sizeActionValue}
            onChange={(event) => {
              setSizeAction(event.target.value === "prune" ? "prune" : "warn");
              save.reset();
            }}
            className="block min-h-8 w-44 rounded-md border border-control-border bg-background px-2"
          >
            <option value="warn">Warn only</option>
            <option value="prune">Prune terminal history</option>
          </select>
        </div>
        <Button
          type="submit"
          data-testid="retention-save"
          disabled={preferences.isPending || !!preferences.error || save.isPending}
        >
          {save.isPending ? "Saving…" : "Save retention"}
        </Button>
      </form>
      {(save.error || preferences.error) && (
        <p role="alert">{save.error?.message ?? preferences.error?.message}</p>
      )}
      {save.isSuccess && <p role="status">Retention saved.</p>}
    </section>
  );
}
