import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AttentionSettings() {
  const client = useQueryClient();
  const preferences = useQuery({ queryKey: ["workspace-preferences"], queryFn: api.settings.get });
  const [hours, setHours] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (value: number) => api.settings.save({ attention_retention_hours: value }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["workspace-preferences"] });
      await client.invalidateQueries({ queryKey: ["human-requests"] });
    },
  });
  const value = hours ?? String(preferences.data?.attention_retention_hours ?? 72);
  return (
    <section className="mt-6 space-y-3" aria-labelledby="attention-settings-title">
      <h2 id="attention-settings-title" className="text-base font-medium">
        Questions and approvals
      </h2>
      <p className="text-sm text-outline">
        Requests leave Attention needed after this many hours from creation. Session continuation
        clears obsolete requests when reported by a supported hook. Saved history is kept.
      </p>
      {preferences.error && <p role="alert">{preferences.error.message}</p>}
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(Number(value));
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="attention-retention">Automatically dismiss after (hours)</Label>
          <Input
            id="attention-retention"
            data-testid="attention-retention-hours"
            type="number"
            min={1}
            max={8760}
            step={1}
            required
            value={value}
            disabled={preferences.isPending || !!preferences.error || save.isPending}
            onChange={(event) => {
              setHours(event.target.value);
              save.reset();
            }}
            className="w-32"
          />
        </div>
        <Button
          data-testid="attention-retention-save"
          type="submit"
          disabled={preferences.isPending || !!preferences.error || save.isPending}
        >
          {save.isPending ? "Saving…" : "Save retention"}
        </Button>
      </form>
      {save.error && <p role="alert">{save.error.message}</p>}
      {save.isSuccess && (
        <p role="status" data-testid="attention-retention-saved">
          Retention saved.
        </p>
      )}
    </section>
  );
}
