import { Bot } from "lucide-react";
import { Link } from "react-router-dom";
import { CopyResume } from "@/components/CopyResume";
import { useTaskSessions } from "@/hooks/useSessions";
import { formatTokens, formatWhen, STATUS } from "@/lib/live-sessions";

export function TaskSessions({ taskId }: { taskId: string }) {
  const { data: sessions } = useTaskSessions(taskId);
  return (
    <div className="border-t border-surface-highest pt-4 space-y-3" data-testid="task-sessions">
      <div className="flex items-center gap-1.5 font-label text-[10px] uppercase tracking-widest text-outline">
        <Bot size={12} />
        Agent sessions{sessions && sessions.length > 0 ? ` · ${sessions.length}` : ""}
      </div>
      {!sessions || sessions.length === 0 ? (
        <div className="font-body text-xs text-outline">
          No session is linked. Pick this task on the Sessions page to link one.
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
              <span className="font-label text-[10px] uppercase tracking-widest text-primary w-14 shrink-0">
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
              <span className="font-label text-[10px] text-outline shrink-0">
                {formatTokens(s)}
              </span>
              <span className="font-label text-[10px] text-outline shrink-0">
                {formatWhen(s.last_activity_at)}
              </span>
              <CopyResume session={s} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
