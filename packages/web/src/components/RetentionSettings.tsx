import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function RetentionSettings() {
  const client = useQueryClient();
  const preferences = useQuery({ queryKey: ["workspace-preferences"], queryFn: api.settings.get });
  const [notifications, setNotifications] = useState<string | null>(null);
  const [audit, setAudit] = useState<string | null>(null);
  const notificationDays =
    notifications ?? String(preferences.data?.notification_retention_days ?? 30);
  const auditDays = audit ?? String(preferences.data?.audit_retention_days ?? 90);
  const save = useMutation({
    mutationFn: () =>
      api.settings.save({
        notification_retention_days: Number(notificationDays),
        audit_retention_days: Number(auditDays),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["workspace-preferences"] });
      await client.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
  return (
    <section className="mt-6 space-y-3" aria-labelledby="retention-title">
      <h3 id="retention-title" className="text-sm font-medium">
        Automatic cleanup
      </h3>
      <p className="max-w-2xl text-sm text-outline">
        Notifications expire even when unresolved. Their source requests are kept independently.
        Audit events remain until their own expiry. These settings apply across ORC clients; shorter
        periods also apply to existing history.
      </p>
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
