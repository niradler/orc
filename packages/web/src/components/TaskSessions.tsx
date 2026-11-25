import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "@/api/client";
import { ErrorState } from "@/components/ErrorState";
import { ResumeActions } from "@/components/ResumeActions";
import { SnoozedWaitingBanner } from "@/components/SnoozeMenu";
import { StateBadge } from "@/components/StateBadge";
import { useHumanRequests } from "@/hooks/useHumanRequests";
import { useTaskSessions } from "@/hooks/useSessions";
import { liveSessionState, rollupState } from "@/lib/agent-state";
import { formatTokenCount, formatTokens, formatWhen, scopedSessionPath } from "@/lib/live-sessions";
import { isRequestSnoozed, pendingRequestsForSession } from "@/lib/snooze";

export function TaskSessions({ taskId }: { taskId: string }) {
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const { data: sessions, isLoading, error, refetch } = useTaskSessions(taskId);
  const humanRequests = useHumanRequests();
  const wakeSnoozed = useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) =>
      api.humanRequests.unsnooze(id, version),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["human-requests"] });
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
  const withTokens = (sessions ?? []).filter((s) => s.tokens_used != null);
  const tokens = withTokens.reduce((sum, s) => sum + (s.tokens_used ?? 0), 0);
  const latest = (sessions ?? [])
    .map((s) => s.last_activity_at ?? "")
    .sort()
    .pop();
  const sessionStates = (sessions ?? []).map((s) => {
    const pending = pendingRequestsForSession(humanRequests.data, {
      sourceId: s.id,
      runtimeId: s.session_id,
      backend: s.agent,
      host: s.host,
    });
    const snoozed = pending.find((request) => isRequestSnoozed(request)) ?? null;
    return {
      session: s,
      state: pending.length > 0 ? ("needs-you" as const) : liveSessionState(s),
      snoozed,
    };
  });
  const groupState = rollupState(sessionStates.map((entry) => entry.state));
  return (
    <div className="border-t border-surface-highest pt-4 space-y-3" data-testid="task-sessions">
      <div className="flex items-center gap-1.5 font-label text-xs text-outline">
        <Bot size={12} />
        Agent sessions
        {groupState && <StateBadge state={groupState} compact testId="task-sessions-state" />}
        {sessions && sessions.length > 0 && (
          <span className="font-body text-xs normal-case tracking-normal text-on-surface-variant">
            {" "}
            · {sessions.length} ·{" "}
            {formatTokenCount(
              tokens,
              withTokens.some((s) => s.tokens_estimated),
            )}{" "}
            tokens · last active {formatWhen(latest ?? null)}
          </span>
        )}
      </div>
      {error ? (
        <ErrorState message={error.message} onRetry={() => refetch()} />
      ) : isLoading ? (
        <p role="status" className="text-sm text-outline">
          Loading agent sessions…
        </p>
      ) : !sessions || sessions.length === 0 ? (
        <div className="font-body text-xs text-outline">
          No session yet. Add a session: line with the session id to the task body, or pick the task
          on the Sessions page.
        </div>
      ) : (
        <div className="space-y-1">
          {sessionStates.map(({ session: s, state, snoozed }) => (
            <div key={s.id} className="space-y-1">
              <div
                data-testid="task-session-row"
                className="flex flex-wrap items-center gap-3 px-2 py-2 rounded-lg"
              >
                <StateBadge state={state} compact context={s.agent} />
                <span className="font-label text-xs text-primary w-14 shrink-0">{s.agent}</span>
                <Link
                  to={scopedSessionPath(
                    `/chat?sessionLive=${encodeURIComponent(s.id)}`,
                    params.get("project") ?? s.project_id,
                  )}
                  data-testid="task-session-link"
                  className="flex-1 min-w-0 truncate font-body text-xs text-on-surface hover:text-primary"
                  title={s.name ?? undefined}
                >
                  {s.name ?? s.session_id}
                </Link>
                <span className="font-label text-xs text-outline shrink-0">{formatTokens(s)}</span>
                <span className="font-label text-xs text-outline shrink-0">
                  {formatWhen(s.last_activity_at)}
                </span>
                <ResumeActions session={s} />
              </div>
              {snoozed && snoozed.snooze_until !== null && (
                <SnoozedWaitingBanner
                  compact
                  until={snoozed.snooze_until}
                  busy={wakeSnoozed.isPending}
                  error={wakeSnoozed.error?.message ?? null}
                  onWake={() => wakeSnoozed.mutate({ id: snoozed.id, version: snoozed.version })}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
