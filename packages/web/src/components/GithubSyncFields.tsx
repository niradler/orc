import {
  DEFAULT_GITHUB_STATUS_LABELS,
  type GithubSyncConfig,
  type GithubSyncState,
} from "@orc/core/github-sync";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function GithubSyncFields({
  value,
  onChange,
  state,
}: {
  value: GithubSyncConfig;
  onChange: (value: GithubSyncConfig) => void;
  state?: GithubSyncState | null;
}) {
  return (
    <div className="space-y-3 md:col-span-2" data-testid="github-sync-settings">
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="github-sync-enabled"
          checked={value.enabled}
          onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
        />
        Sync repository issues as tasks
      </label>
      <p className="text-xs text-muted-foreground">
        Statuses sync both ways every minute while the API runs. Imported issues never start agents
        automatically.
      </p>
      {state?.error && (
        <p role="alert" className="text-sm text-error">
          {state.error}
        </p>
      )}
      {value.enabled && (
        <details>
          <summary className="min-h-11 cursor-pointer py-3 text-sm">Status labels</summary>
          <div className="grid gap-3 sm:grid-cols-2">
            {Object.keys(DEFAULT_GITHUB_STATUS_LABELS).map((name) => {
              const status = name as keyof typeof DEFAULT_GITHUB_STATUS_LABELS;
              return (
                <div key={status} className="space-y-1">
                  <Label htmlFor={`github-label-${status}`}>{status.replace(/_/g, " ")}</Label>
                  <Input
                    id={`github-label-${status}`}
                    data-testid={`github-label-${status}`}
                    value={value.status_labels[status]}
                    maxLength={50}
                    onChange={(event) =>
                      onChange({
                        ...value,
                        status_labels: { ...value.status_labels, [status]: event.target.value },
                      })
                    }
                  />
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}
