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
  const [history, setHistory] = useState<string | null>(null);
  const notificationDays =
    notifications ?? String(preferences.data?.notification_retention_days ?? 30);
  const auditDays = audit ?? String(preferences.data?.audit_retention_days ?? 90);
  const historyDays = history ?? String(preferences.data?.history_retention_days ?? 7);
  const save = useMutation({
    mutationFn: () =>
      api.settings.save({
        notification_retention_days: Number(notificationDays),
        audit_retention_days: Number(auditDays),
        history_retention_days: Number(historyDays),
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
          Notifications expire even when unresolved; their requests are kept. Audit events use their
          own expiry. History covers finished job and flow runs, stopped sessions, answered requests
          and finished MCP tasks; pending work is never deleted. Shorter periods also apply to
          existing history.
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
          <Label htmlFor="history-retention-days">Job &amp; request history (days)</Label>
          <Input
            id="history-retention-days"
            data-testid="history-retention-days"
            type="number"
            min={1}
            max={3650}
            step={1}
            required
            value={historyDays}
            onChange={(event) => {
              setHistory(event.target.value);
              save.reset();
            }}
            className="w-32"
          />
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
