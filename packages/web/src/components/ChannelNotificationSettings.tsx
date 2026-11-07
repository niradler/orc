import type { ChannelTarget } from "@orc/core/channels";
import {
  NOTIFICATION_TYPES,
  type NotificationFilter,
  NotificationFilterSchema,
  type NotificationForwardingPolicy,
} from "@orc/core/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="inline-flex min-h-11 items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="size-4 accent-primary"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

export function ChannelNotificationFilters({
  target,
  projects,
  onChange,
}: {
  target: ChannelTarget;
  projects: { id: string; name: string }[];
  onChange: (filter: NotificationFilter) => void;
}) {
  const filter = target.notifications ?? NotificationFilterSchema.parse({});
  const [sample, setSample] = useState("job.failed");
  const [project, setProject] = useState("");
  const [result, setResult] = useState<{ matches: boolean; summary: string } | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  function update(value: NotificationFilter): void {
    setResult(null);
    onChange(value);
  }
  function options<K extends "types" | "categories" | "levels" | "outcomes">(
    key: K,
    values: readonly NotificationFilter[K][number][],
  ) {
    return (
      <div className="flex flex-wrap gap-x-4">
        {values.map((value) => (
          <Toggle
            key={value}
            label={value}
            checked={filter[key].includes(value as never)}
            onChange={(checked) =>
              update({
                ...filter,
                [key]: checked
                  ? [...filter[key], value]
                  : filter[key].filter((item) => item !== value),
              })
            }
          />
        ))}
      </div>
    );
  }
  return (
    <div data-testid="channel-notification-filters" className="space-y-2">
      <Toggle
        label="Forward notifications"
        checked={filter.enabled}
        onChange={(enabled) => update({ ...filter, enabled })}
      />
      <p className="text-xs text-outline">
        Safe summaries and links only. Uses this recipient’s project restrictions. Does not allow
        replies or approvals. Replaces interactive question delivery for this recipient while
        selected.
      </p>
      {filter.enabled && (
        <details className="border-t border-border">
          <summary className="min-h-11 cursor-pointer py-3 text-sm">
            Notification filters and preview
          </summary>
          <div className="space-y-3 pb-2">
            <p className="text-xs text-outline">
              Empty groups match all known values. Selected groups must all match. New types are
              excluded by default.
            </p>
            <fieldset>
              <legend className="text-sm font-medium">Types</legend>
              {options("types", NOTIFICATION_TYPES)}
            </fieldset>
            <fieldset>
              <legend className="text-sm font-medium">Categories</legend>
              {options("categories", ["human", "agent", "job"])}
            </fieldset>
            <fieldset>
              <legend className="text-sm font-medium">Severity</legend>
              {options("levels", ["needs-you", "done"])}
            </fieldset>
            <fieldset>
              <legend className="text-sm font-medium">Outcome</legend>
              {options("outcomes", ["waiting", "success", "failure"])}
            </fieldset>
            <Toggle
              label="Include new or unknown types"
              checked={filter.include_unknown}
              onChange={(include_unknown) => update({ ...filter, include_unknown })}
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">
                Preview event
                <select
                  data-testid="notification-preview-type"
                  className="form-control form-control-single w-full"
                  value={sample}
                  onChange={(event) => {
                    setSample(event.target.value);
                    setResult(null);
                  }}
                >
                  {[...NOTIFICATION_TYPES, "future.custom"].map((type) => (
                    <option key={type}>{type}</option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Preview project
                <select
                  data-testid="notification-preview-project"
                  className="form-control form-control-single w-full"
                  value={project}
                  onChange={(event) => {
                    setProject(event.target.value);
                    setResult(null);
                  }}
                >
                  <option value="">Unassigned</option>
                  {projects.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <Button
              type="button"
              variant="outline"
              data-testid="notification-filter-preview"
              disabled={pending}
              onClick={async () => {
                setPending(true);
                setError("");
                try {
                  setResult(
                    await api.channels.notificationPreview({
                      filter,
                      project_ids: target.project_ids,
                      event: {
                        type: sample,
                        level: sample.endsWith("finished") ? "done" : "needs-you",
                        project_id: project || null,
                      },
                    }),
                  );
                } catch (error) {
                  setError(error instanceof Error ? error.message : "Preview failed");
                } finally {
                  setPending(false);
                }
              }}
            >
              Preview filters
            </Button>
            {result && (
              <div role="status" data-testid="notification-preview-result" className="text-sm">
                <p>{result.matches ? "Matches draft filters" : "Does not match draft filters"}</p>
                <p className="text-xs text-outline">
                  {result.summary} No message sent. Delivery also requires global forwarding, an
                  enabled outbound connection and producer permission.
                </p>
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-error">
                {error}
              </p>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

export function ChannelNotificationSettings({ active }: { active: boolean }) {
  const urlId = useId();
  const client = useQueryClient();
  const policy = useQuery({
    queryKey: ["channel-notification-policy"],
    queryFn: api.channels.notificationPolicy,
    enabled: active,
  });
  const [expanded, setExpanded] = useState(false);
  const deliveries = useQuery({
    queryKey: ["channel-notification-deliveries"],
    queryFn: api.channels.notificationDeliveries,
    enabled: active && expanded,
    refetchInterval: active && expanded ? 15000 : false,
  });
  const [draft, setDraft] = useState<NotificationForwardingPolicy | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const value = draft ?? policy.data ?? { enabled: false, base_url: "" };
  return (
    <details
      data-testid="channel-notification-settings"
      className="border-y border-border"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="min-h-11 cursor-pointer py-3 text-sm">
        Notification forwarding · {policy.data?.enabled ? "enabled" : "paused"}
      </summary>
      <div className="space-y-3 pb-3">
        <p className="text-xs text-outline">
          Enable forwarding here and opt in each recipient below. Only new events after activation
          are forwarded; history and events during a pause are not replayed. In-app notifications
          stay enabled. An in-flight send may finish after pausing.
        </p>
        <Toggle
          label="Enable channel notification forwarding"
          checked={value.enabled}
          onChange={(enabled) => setDraft({ ...value, enabled })}
        />
        <label htmlFor={urlId} className="grid gap-1 text-sm">
          ORC URL for source links
          <Input
            data-testid="notification-base-url"
            id={urlId}
            type="url"
            placeholder="https://orc.example.com"
            value={value.base_url}
            onChange={(event) => setDraft({ ...value, base_url: event.target.value })}
          />
        </label>
        <p className="text-xs text-outline">
          Use the ORC origin reachable from your phone or channel client. No credentials, path or
          query parameters.
        </p>
        <Button
          type="button"
          size="sm"
          data-testid="notification-policy-save"
          disabled={pending || policy.isPending || !!policy.error}
          onClick={async () => {
            setPending(true);
            setError("");
            setMessage("");
            try {
              const saved = await api.channels.saveNotificationPolicy(value);
              client.setQueryData(["channel-notification-policy"], saved);
              setDraft(null);
              setMessage(
                saved.enabled
                  ? "Notification forwarding enabled."
                  : "Notification forwarding paused.",
              );
            } catch (error) {
              setError(error instanceof Error ? error.message : "Could not save policy");
            } finally {
              setPending(false);
            }
          }}
        >
          Save forwarding settings
        </Button>
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
        {(error || policy.error) && (
          <p role="alert" className="text-sm text-error">
            {error || policy.error?.message}
          </p>
        )}
        <details>
          <summary className="min-h-11 cursor-pointer py-3 text-sm">
            Recent deliveries ({deliveries.data?.length ?? 0})
          </summary>
          {deliveries.error && (
            <p role="alert" className="text-sm text-error">
              {deliveries.error.message}
            </p>
          )}
          {deliveries.data?.length === 0 && (
            <p className="py-2 text-sm text-outline">No notification deliveries yet.</p>
          )}
          <div data-testid="notification-delivery-status" className="max-h-64 overflow-y-auto">
            {deliveries.data?.map((item) => (
              <div
                key={`${item.notification_id}:${item.connection_id}:${item.target_id}`}
                className="border-t border-border py-2 text-xs"
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <span>
                    {item.connection_id} / {item.target_id}
                  </span>
                  <span>
                    {item.status} · {item.attempts} attempt(s)
                  </span>
                </div>
                {item.error && <p className="mt-1 text-error">{item.error}</p>}
                <p className="mt-1 truncate text-outline" title={item.notification_id}>
                  {item.notification_id}
                </p>
              </div>
            ))}
          </div>
        </details>
      </div>
    </details>
  );
}
