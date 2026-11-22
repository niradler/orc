import { ChevronDown, CircleStop, Target, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { Goal } from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { HelpPopover } from "@/components/HelpPopover";
import { Button } from "@/components/ui/button";
import { useGoal, useStopGoal, useTaskGoal } from "@/hooks/useGoals";
import { formatDuration, formatUnixTime } from "@/lib/flow-graph";

const STATUS_COLORS: Record<string, string> = {
  active: "bg-primary/15 text-primary border-primary/40",
  passed: "bg-secondary/15 text-secondary border-secondary/40",
  halted: "bg-error/15 text-error border-error/40",
  stopped: "bg-surface-highest text-outline border-outline-variant",
};

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex px-2 py-0.5 font-label text-xs rounded-md border ${
        className ?? "bg-surface-highest border-surface-highest text-on-surface-variant"
      }`}
    >
      {children}
    </span>
  );
}

function Fact({
  label,
  children,
  testId,
}: {
  label: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="space-y-0.5">
      <div className="font-label text-[10px] font-medium text-outline">{label}</div>
      <div className="font-body text-sm text-on-surface-variant" data-testid={testId}>
        {children}
      </div>
    </div>
  );
}

/**
 * The goal loop on its task (#173): iteration, current agent, stall ladder,
 * budget left and the last check — derived live from the flow run. The check
 * history stays a quiet summary until asked for.
 */
export function GoalPanel({ taskId, taskStatus }: { taskId: string; taskStatus: string }) {
  const { data: goal, isLoading } = useTaskGoal(taskId);
  if (isLoading || !goal) return null;
  return <GoalBody goal={goal} taskStatus={taskStatus} />;
}

function GoalBody({ goal, taskStatus }: { goal: Goal; taskStatus: string }) {
  const run = goal.run;
  const stop = useStopGoal();
  const [stopping, setStopping] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  const history = useGoal(showHistory ? goal.id : null);

  const status = run?.status ?? goal.status;
  const active = status === "active";
  // The ladder's last rung parks the task at `blocked` while a human decides.
  const escalated = active && taskStatus === "blocked";
  const agent = run ? (goal.spec.agents[run.stage] ?? goal.spec.agents[0]) : null;
  const iterationsLeft = run ? Math.max(0, goal.spec.budget.iterations - run.iteration) : null;
  const tokensLeft =
    run && goal.spec.budget.tokens !== undefined
      ? Math.max(0, goal.spec.budget.tokens - run.tokens_used)
      : null;
  const elapsedHours = (Date.now() - goal.created_at) / 3_600_000;
  const hoursLeft = active ? Math.max(0, goal.spec.budget.hours - elapsedHours) : null;

  return (
    <div className="space-y-3" data-testid="goal-panel" data-goal-status={status}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 min-w-0">
          <Target size={12} className="text-outline shrink-0" />
          <span className="font-label text-xs font-medium text-outline">Goal</span>
          <Chip className={STATUS_COLORS[status]}>{status}</Chip>
          <HelpPopover label="goal loops" testId="goal-help">
            Loops a worker and the success check until it passes. A stalled metric moves to the next
            agent, a reviewer, then one human request. Budgets cap iterations, tokens and time.
          </HelpPopover>
        </div>
        {active && (
          <Button
            variant="ghost"
            size="sm"
            data-testid="goal-stop-button"
            onClick={() => setStopping(true)}
            className="font-label text-xs bg-error/10 text-error border border-error/30 hover:bg-error/20 min-h-11 sm:min-h-9 px-3"
          >
            <CircleStop size={11} className="mr-1" />
            Stop
          </Button>
        )}
      </div>

      <p className="font-body text-sm text-on-surface" data-testid="goal-objective">
        {goal.objective}
      </p>

      {escalated && (
        <div
          className="flex items-start gap-2 p-2 rounded-lg border border-tertiary/40 bg-tertiary/10"
          data-testid="goal-escalation"
        >
          <TriangleAlert size={14} className="text-tertiary mt-0.5 shrink-0" />
          <div className="font-body text-sm text-on-surface-variant">
            Stalled across every allowed agent — a human must decide. Resolve the waiting node in
            the flow below, or stop the goal.
          </div>
        </div>
      )}

      {run && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1">
          <Fact label="Iteration" testId="goal-iteration">
            {run.iteration} / {goal.spec.budget.iterations}
            {iterationsLeft !== null && active ? ` · ${iterationsLeft} left` : ""}
          </Fact>
          <Fact label="Agent" testId="goal-agent">
            {agent}
            {goal.spec.agents.length > 1
              ? ` (stage ${run.stage + 1}/${goal.spec.agents.length})`
              : ""}
          </Fact>
          <Fact label="Stall" testId="goal-stall">
            {run.stall} / {goal.spec.stall_limit}
          </Fact>
          <Fact label="Tokens" testId="goal-tokens">
            {run.tokens_used.toLocaleString()}
            {goal.spec.budget.tokens !== undefined
              ? ` / ${goal.spec.budget.tokens.toLocaleString()}`
              : " · no cap"}
            {tokensLeft !== null && active ? ` · ${tokensLeft.toLocaleString()} left` : ""}
          </Fact>
          <Fact label="Time" testId="goal-time">
            {hoursLeft !== null
              ? `${hoursLeft.toFixed(1)}h left of ${goal.spec.budget.hours}h`
              : formatDuration(run.started_at, run.ended_at)}
          </Fact>
          <Fact label="Last check" testId="goal-last-check">
            {run.last_check
              ? `exit ${run.last_check.exit}${
                  run.last_check.metric !== null ? ` · metric ${run.last_check.metric}` : ""
                }`
              : "not run yet"}
          </Fact>
        </div>
      )}

      {run?.halt_reason && (
        <div className="font-body text-sm text-error" data-testid="goal-halt-reason">
          Halted: {run.halt_reason.replace(/_/g, " ")}
        </div>
      )}

      {run?.last_check?.output && (
        <div className="space-y-1">
          <button
            type="button"
            onClick={() => setShowOutput((prev) => !prev)}
            className="flex items-center gap-1 font-label text-xs text-outline hover:text-on-surface-variant"
            data-testid="goal-check-output-toggle"
          >
            <ChevronDown size={12} className={showOutput ? "" : "-rotate-90"} />
            Last check output
          </button>
          {showOutput && (
            <pre
              className="p-2 rounded-lg bg-surface-highest font-mono text-xs text-on-surface-variant whitespace-pre-wrap break-words max-h-48 overflow-y-auto"
              data-testid="goal-check-output"
            >
              {run.last_check.output}
            </pre>
          )}
        </div>
      )}

      <div className="space-y-1">
        <button
          type="button"
          onClick={() => setShowHistory((prev) => !prev)}
          className="flex items-center gap-1 font-label text-xs text-outline hover:text-on-surface-variant"
          data-testid="goal-history-toggle"
        >
          <ChevronDown size={12} className={showHistory ? "" : "-rotate-90"} />
          Check history
          {run ? ` · ${run.iteration} check${run.iteration === 1 ? "" : "s"}` : ""}
        </button>
        {showHistory && (
          <div className="space-y-1" data-testid="goal-history">
            {history.isLoading && (
              <div className="font-body text-sm text-outline">Loading checks…</div>
            )}
            {history.data?.history.length === 0 && (
              <div className="font-body text-sm text-outline">No checks have run yet.</div>
            )}
            {history.data?.history.map((visit) => (
              <div
                key={`${visit.attempt}-${visit.retry}`}
                className="flex items-center gap-2 text-xs font-body"
              >
                <span
                  className={
                    visit.outcome === "passed"
                      ? "text-secondary"
                      : visit.outcome === "failed"
                        ? "text-error"
                        : "text-outline"
                  }
                >
                  {visit.outcome ?? "running"}
                </span>
                <span className="text-on-surface-variant truncate">{visit.summary ?? ""}</span>
                <span className="text-outline ml-auto shrink-0">
                  {visit.ended_at ? formatUnixTime(visit.ended_at) : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={stopping}
        title="Stop Goal"
        description={`Stop this goal's loop and kill its live agent sessions? The task keeps its current status; the check history stays on the flow.`}
        confirmLabel="Stop"
        variant="destructive"
        isPending={stop.isPending}
        onConfirm={() => stop.mutate({ id: goal.id }, { onSuccess: () => setStopping(false) })}
        onCancel={() => setStopping(false)}
      />
    </div>
  );
}
