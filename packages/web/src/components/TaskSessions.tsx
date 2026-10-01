import { Bot } from "lucide-react";
import { Link } from "react-router-dom";
import { ResumeActions } from "@/components/ResumeActions";
import { useTaskSessions } from "@/hooks/useSessions";
import { formatTokenCount, formatTokens, formatWhen, STATUS } from "@/lib/live-sessions";

export function TaskSessions({ taskId }: { taskId: string }) {
  const { data: sessions } = useTaskSessions(taskId);
  const withTokens = (sessions ?? []).filter((s) => s.tokens_used != null);
  const tokens = withTokens.reduce((sum, s) => sum + (s.tokens_used ?? 0), 0);
  const latest = (sessions ?? [])
    .map((s) => s.last_activity_at ?? "")
    .sort()
    .pop();
  return (
    <div className="border-t border-surface-highest pt-4 space-y-3" data-testid="task-sessions">
      <div className="flex items-center gap-1.5 font-label text-[11px] uppercase tracking-widest text-outline">
        <Bot size={12} />
        Agent sessions
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
      {!sessions || sessions.length === 0 ? (
        <div className="font-body text-xs text-outline">
          No session yet. Add a session: line with the session id to the task body, or pick the task
          on the Sessions page.
        </div>
      ) : (
        <div className="space-y-1">
          {sessions.map((s) => (
            <div
              key={s.id}
              data-testid="task-session-row"
              className="flex items-center gap-3 px-2 py-1.5 bg-surface-highest/50 rounded-sm"
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${STATUS[s.status].dot}`}
                title={STATUS[s.status].label}
              />
              <span className="font-label text-[11px] uppercase tracking-widest text-primary w-14 shrink-0">
                {s.agent}
              </span>
              <Link
                to={`/sessions?session=${s.id}`}
                data-testid="task-session-link"
                className="flex-1 min-w-0 truncate font-body text-xs text-on-surface hover:text-primary"
                title={s.name ?? undefined}
              >
                {s.name ?? s.session_id}
              </Link>
              <span className="font-label text-[11px] text-outline shrink-0">
                {formatTokens(s)}
              </span>
              <span className="font-label text-[11px] text-outline shrink-0">
                {formatWhen(s.last_activity_at)}
              </span>
              <ResumeActions session={s} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
