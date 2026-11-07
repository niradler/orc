import type { AuditEntry } from "@orc/sdk/types";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useState } from "react";
import { api } from "@/api/client";
import { ResponsiveFilters } from "@/components/ResponsiveFilters";
import { Button } from "@/components/ui/button";
import { useViewParam } from "@/lib/view-params";

const ENTITY_TYPES = [
  "all",
  "notification",
  "human_request",
  "job_run",
  "task",
  "settings",
  "memory",
  "skill",
  "kb",
] as const;
const ENTITY_LABELS: Record<(typeof ENTITY_TYPES)[number], string> = {
  all: "All events",
  notification: "Notifications",
  human_request: "Human requests",
  job_run: "Job runs",
  task: "Tasks",
  settings: "Settings",
  memory: "Memories",
  skill: "Skills",
  kb: "Knowledge",
};
const DISPLAY_LIMIT = 100;

function actionLabel(action: string): string {
  const words = action.replace(/[._-]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function metadataPreview(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (!value || typeof value !== "object") return value;
  if (depth >= 3) return "…";
  if (Array.isArray(value))
    return value.slice(0, 10).map((item) => metadataPreview(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 12)
      .map(([key, item]) => [key, metadataPreview(item, depth + 1)]),
  );
}

function metadataText(value: unknown): string {
  const text = JSON.stringify(metadataPreview(value), null, 2);
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
}

function EventRow({ entry }: { entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false);
  const date = new Date(entry.created_at * 1000);
  const subjects = entry.subject_ids.slice(0, 3).join(", ") || "Workspace";
  return (
    <li>
      <details
        data-testid="audit-event"
        className="group py-1"
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className="grid min-h-11 cursor-pointer list-inside grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded py-2 text-sm focus-visible:outline-2 focus-visible:outline-focus md:min-h-9 md:grid-cols-[minmax(12rem,1fr)_minmax(0,1fr)_auto]">
          <span className="flex min-w-0 items-center gap-1 font-medium">
            <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
            {actionLabel(entry.action)}
          </span>
          <span
            className="col-start-1 min-w-0 truncate text-xs text-outline md:col-start-auto"
            title={subjects}
          >
            {subjects}
          </span>
          <time
            dateTime={date.toISOString()}
            className="col-start-2 row-start-1 whitespace-nowrap text-xs text-outline md:col-start-auto md:row-start-auto"
          >
            {date.toLocaleString()}
          </time>
        </summary>
        {expanded && (
          <div className="space-y-2 pb-3 pl-3 text-xs text-outline">
            <p>
              Project: {entry.project_id ?? "Unassigned"} · Actor: {entry.actor ?? "Not recorded"}
            </p>
            {entry.session_id && <p className="break-all">Session: {entry.session_id}</p>}
            {entry.result_ids.length > 0 && (
              <p className="break-all">Results: {entry.result_ids.slice(0, 10).join(", ")}</p>
            )}
            {entry.note && (
              <p className="whitespace-pre-wrap break-words">{entry.note.slice(0, 1000)}</p>
            )}
            {entry.snapshot !== null && entry.snapshot !== undefined && (
              <div>
                <p className="mb-1">Metadata preview</p>
                <pre
                  data-testid="audit-event-metadata"
                  className="max-h-56 overflow-auto whitespace-pre-wrap break-all text-xs text-on-surface"
                >
                  {metadataText(entry.snapshot)}
                </pre>
              </div>
            )}
          </div>
        )}
      </details>
    </li>
  );
}

export function AuditEvents({ projectId }: { projectId: string }) {
  const [entityType, setEntityType] = useViewParam("auditEntity", "all", ENTITY_TYPES);
  const events = useQuery({
    queryKey: ["audit", "events", projectId, entityType],
    queryFn: () =>
      api.audit.list({
        ...(projectId === "all"
          ? { scope: "all" as const }
          : projectId === "unassigned"
            ? { scope: "global" as const }
            : { project_id: projectId }),
        ...(entityType === "all" ? {} : { entity_type: entityType }),
        limit: DISPLAY_LIMIT,
        snapshot: "preview",
      }),
    retry: false,
  });
  return (
    <section aria-label="Audit events" data-testid="audit-events" className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-outline">Up to {DISPLAY_LIMIT} newest events</p>
        <div className="flex flex-wrap items-center gap-2">
          <ResponsiveFilters activeCount={entityType === "all" ? 0 : 1}>
            <select
              aria-label="Audit event type"
              data-testid="audit-event-filter"
              className="form-control form-control-single"
              value={entityType}
              onChange={(event) =>
                setEntityType(event.target.value as (typeof ENTITY_TYPES)[number])
              }
            >
              {ENTITY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {ENTITY_LABELS[type]}
                </option>
              ))}
            </select>
          </ResponsiveFilters>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void events.refetch()}
            disabled={events.isFetching}
            data-testid="audit-events-refresh"
          >
            <RefreshCw className="size-4" />
            Refresh
          </Button>
        </div>
      </div>
      {events.isLoading && (
        <p role="status" className="py-4 text-sm text-outline">
          Loading events…
        </p>
      )}
      {events.error && (
        <p role="alert" className="py-3 text-sm text-error">
          Could not load audit events: {events.error.message}
        </p>
      )}
      {!events.isLoading && !events.error && events.data?.entries.length === 0 && (
        <p className="py-6 text-sm text-outline">No audit events in this scope.</p>
      )}
      {events.data && (
        <ol className="divide-y divide-border">
          {events.data.entries.map((entry) => (
            <EventRow key={entry.id} entry={entry} />
          ))}
        </ol>
      )}
    </section>
  );
}
