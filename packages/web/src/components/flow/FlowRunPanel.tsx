import { CircleStop, GitBranch, UserCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { FlowNodeRun, FlowRun } from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FlowGraph, FlowGraphLegend } from "@/components/flow/FlowGraph";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useHaltFlow, useResumeFlow, useTaskFlow } from "@/hooks/useFlows";
import {
  awaitingHumanRun,
  describeCondition,
  type FlowGraphDefinition,
  formatDuration,
  formatUnixTime,
  isLive,
  nodeLedgerStates,
  routableOutcomes,
  toFlowDefinition,
} from "@/lib/flow-graph";

/** Vars the runner injects into every run - not worth showing as flow state. */
const RESERVED_VARS = new Set([
  "task_id",
  "task_title",
  "project_id",
  "skill_name",
  "required_review",
  "max_review_rounds",
]);

const RUN_STATUS_COLORS: Record<string, string> = {
  running: "bg-primary/15 text-primary border-primary/40",
  completed: "bg-secondary/15 text-secondary border-secondary/40",
  halted: "bg-error/15 text-error border-error/40",
  cancelled: "bg-surface-highest text-outline border-outline-variant",
};

const NODE_STATUS_COLORS: Record<string, string> = {
  pending: "text-primary",
  running: "text-primary",
  awaiting_human: "text-tertiary",
  succeeded: "text-secondary",
  failed: "text-error",
  cancelled: "text-outline",
  skipped: "text-outline",
};

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex px-2 py-0.5 font-label text-[10px] uppercase tracking-wider border ${
        className ?? "bg-surface-highest border-surface-highest text-on-surface-variant"
      }`}
    >
      {children}
    </span>
  );
}

interface FlowRunPanelProps {
  taskId: string;
}

export function FlowRunPanel({ taskId }: FlowRunPanelProps) {
  const { data: run, isLoading } = useTaskFlow(taskId);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  if (isLoading) {
    return <div className="font-body text-xs text-outline">Loading flow…</div>;
  }
  if (!run) {
    return (
      <div className="font-body text-xs text-outline" data-testid="flow-run-empty">
        No flow has run on this task yet.
      </div>
    );
  }

  return (
    <FlowRunBody
      run={run}
      taskId={taskId}
      selectedNodeId={selectedNodeId}
      onSelectNode={(id) => setSelectedNodeId((prev) => (prev === id ? null : id))}
    />
  );
}

function FlowRunBody({
  run,
  taskId,
  selectedNodeId,
  onSelectNode,
}: {
  run: FlowRun;
  taskId: string;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const definition = useMemo(() => toFlowDefinition(run.definition), [run.definition]);
  const states = useMemo(() => nodeLedgerStates(run), [run]);
  const waiting = useMemo(() => awaitingHumanRun(run), [run]);
  const halt = useHaltFlow();
  const [halting, setHalting] = useState(false);

  const flowVars = Object.entries(run.vars).filter(([k]) => !RESERVED_VARS.has(k));

  return (
    <div className="space-y-4" data-testid="flow-run-panel" data-flow-status={run.status}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Link
            to={`/flows/${encodeURIComponent(run.flow_name)}`}
            className="font-body text-xs text-primary hover:underline truncate"
            data-testid="flow-run-name"
          >
            {run.flow_name}
          </Link>
          <Chip>{run.flow_source}</Chip>
          <Chip className={RUN_STATUS_COLORS[run.status]}>{run.status}</Chip>
        </div>
        {run.status === "running" && (
          <Button
            data-testid="flow-halt-button"
            size="sm"
            onClick={() => setHalting(true)}
            className="font-label text-[10px] uppercase bg-error/10 text-error border border-error/30 hover:bg-error/20 h-6 px-2"
          >
            <CircleStop size={11} className="mr-1" />
            Halt
          </Button>
        )}
      </div>

      {run.halt_reason && (
        <div
          className="p-2 rounded-sm border border-error/30 bg-error/5 space-y-0.5"
          data-testid="flow-halt-reason"
          data-halt-reason={run.halt_reason}
        >
          <div className="font-label text-[10px] uppercase tracking-widest text-error">
            Halted: {run.halt_reason.replace(/_/g, " ")}
          </div>
          {run.halt_description && (
            <div className="font-body text-xs text-on-surface-variant">{run.halt_description}</div>
          )}
        </div>
      )}

      {definition ? (
        <div>
          <FlowGraph
            definition={definition}
            states={states}
            selectedNodeId={selectedNodeId}
            onSelectNode={onSelectNode}
          />
          <FlowGraphLegend />
        </div>
      ) : (
        <div className="font-body text-xs text-outline">
          This run did not record a readable definition, so its graph cannot be drawn.
        </div>
      )}

      {waiting && (
        <HumanGateForm
          taskId={taskId}
          nodeRun={waiting}
          definition={definition}
          isHalting={halt.isPending}
        />
      )}

      {definition && selectedNodeId && (
        <NodeDetail definition={definition} nodeId={selectedNodeId} />
      )}

      <Ledger run={run} selectedNodeId={selectedNodeId} onSelectNode={onSelectNode} />

      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <RunFact label="Executions">
          {run.node_executions}
          {definition?.limits.max_node_executions
            ? ` / ${definition.limits.max_node_executions}`
            : ""}
        </RunFact>
        <RunFact label="Elapsed">{formatDuration(run.started_at, run.ended_at)}</RunFact>
        <RunFact label="Started">{formatUnixTime(run.started_at)}</RunFact>
        <RunFact label="Ended">{formatUnixTime(run.ended_at)}</RunFact>
      </div>

      {flowVars.length > 0 && (
        <div className="space-y-1" data-testid="flow-run-vars">
          <div className="font-label text-[10px] uppercase tracking-widest text-outline">
            Run vars
          </div>
          <div className="flex flex-wrap gap-1">
            {flowVars.map(([key, value]) => (
              <Chip key={key}>
                {key}={JSON.stringify(value)}
              </Chip>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={halting}
        title="Halt Flow"
        description={`Stop flow "${run.flow_name}" and kill any live agent sessions for this task? The task keeps its current status.`}
        confirmLabel="Halt"
        variant="destructive"
        isPending={halt.isPending}
        onConfirm={() =>
          halt.mutate(
            { taskId, reason: "halted from the web dashboard" },
            { onSuccess: () => setHalting(false) },
          )
        }
        onCancel={() => setHalting(false)}
      />
    </div>
  );
}

function RunFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="font-label text-[9px] uppercase tracking-widest text-outline">{label}</div>
      <div className="font-body text-xs text-on-surface-variant">{children}</div>
    </div>
  );
}

function HumanGateForm({
  taskId,
  nodeRun,
  definition,
  isHalting,
}: {
  taskId: string;
  nodeRun: FlowNodeRun;
  definition: FlowGraphDefinition | null;
  isHalting: boolean;
}) {
  // Exactly the verdicts this node's own edges can route - the same list the API
  // validates against. Empty means the node has only a catch-all edge, and the
  // API will accept whatever it is given, so ask for it instead of guessing.
  const outcomes = useMemo(
    () => (definition ? routableOutcomes(definition, nodeRun.node_id) : []),
    [definition, nodeRun.node_id],
  );
  const resume = useResumeFlow();
  const [outcome, setOutcome] = useState<string>(outcomes[0] ?? "");
  const [comment, setComment] = useState("");

  const chosen = outcome.trim();

  return (
    <div
      className="p-3 rounded-sm border border-tertiary/40 bg-tertiary/5 space-y-3"
      data-testid="flow-gate-form"
      data-gate-node={nodeRun.node_id}
    >
      <div className="flex items-center gap-1.5 font-label text-[10px] uppercase tracking-widest text-tertiary">
        <UserCheck size={12} />
        Waiting for you at “{nodeRun.node_id}”
      </div>
      {definition?.nodeById[nodeRun.node_id]?.prompt && (
        <div className="font-body text-xs text-on-surface whitespace-pre-wrap">
          {definition.nodeById[nodeRun.node_id]?.prompt}
        </div>
      )}

      <div className="space-y-1.5">
        <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
          Outcome
        </Label>
        {outcomes.length > 0 ? (
          <Select value={outcome} onValueChange={setOutcome}>
            <SelectTrigger
              data-testid="flow-gate-outcome"
              className="bg-background border-surface-highest text-on-surface font-label text-xs h-7"
            >
              <SelectValue placeholder="Pick an outcome" />
            </SelectTrigger>
            <SelectContent className="bg-surface-highest border-surface-highest">
              {outcomes.map((o) => (
                <SelectItem key={o} value={o} className="font-label text-xs">
                  {o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <>
            <Input
              data-testid="flow-gate-outcome-input"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              placeholder="e.g. approved"
              className="bg-background border-surface-highest text-on-surface font-body text-xs h-7"
            />
            <p className="font-body text-[10px] text-outline">
              This node routes everything through a catch-all edge, so any outcome continues the
              flow.
            </p>
          </>
        )}
      </div>

      <div className="space-y-1.5">
        <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
          Comment (posted on the task)
        </Label>
        <Textarea
          data-testid="flow-gate-comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Why this outcome…"
          className="bg-background border-surface-highest text-on-surface font-body text-xs resize-none"
          rows={2}
        />
      </div>

      {resume.error && (
        <div className="font-body text-xs text-error" data-testid="flow-gate-error">
          {(resume.error as Error).message}
        </div>
      )}

      <div className="flex justify-end">
        <Button
          data-testid="flow-gate-submit"
          size="sm"
          disabled={resume.isPending || isHalting || chosen.length === 0}
          onClick={() =>
            resume.mutate(
              {
                taskId,
                outcome: chosen,
                ...(comment.trim() ? { summary: comment.trim() } : {}),
                author: "human",
              },
              { onSuccess: () => setComment("") },
            )
          }
          className="font-label text-[10px] uppercase bg-tertiary/15 text-tertiary border border-tertiary/30 hover:bg-tertiary/25 h-6 px-2"
        >
          {resume.isPending ? "…" : "Resume Flow"}
        </Button>
      </div>
    </div>
  );
}

function NodeDetail({ definition, nodeId }: { definition: FlowGraphDefinition; nodeId: string }) {
  const node = definition.nodeById[nodeId];
  if (!node) return null;
  // Keep each edge's position in the definition: it is the edge's only identity
  // (two edges may share from/to and differ only in `when`) and the order is
  // what decides which one wins.
  const outgoing = definition.edges
    .map((edge, index) => ({ edge, index }))
    .filter(({ edge }) => edge.from === nodeId);

  return (
    <div
      className="p-2 rounded-sm border border-surface-highest bg-surface-highest/30 space-y-2"
      data-testid="flow-node-detail"
      data-node-id={nodeId}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-body text-xs font-medium text-on-surface">{node.id}</span>
        <Chip>{node.kind}</Chip>
        {node.skill && <Chip>skill {node.skill}</Chip>}
        {node.role && <Chip>{node.role}</Chip>}
        {node.task_status && <Chip>sets {node.task_status}</Chip>}
        {node.max_visits !== undefined && <Chip>max {node.max_visits} visits</Chip>}
        {node.routing === "all" && <Chip>fan out</Chip>}
        {node.join && (
          <Chip>
            join {node.join.mode} of {node.join.from.join(", ")}
          </Chip>
        )}
        {node.on_error && <Chip>on error → {node.on_error}</Chip>}
      </div>
      {node.description && (
        <div className="font-body text-xs text-on-surface-variant">{node.description}</div>
      )}
      {outgoing.length > 0 && (
        <div className="space-y-0.5">
          <div className="font-label text-[9px] uppercase tracking-widest text-outline">
            Outgoing edges (first match wins)
          </div>
          {outgoing.map(({ edge, index }, i) => (
            <div
              key={index}
              className="font-mono text-[10px] text-on-surface-variant"
              data-testid="flow-node-detail-edge"
            >
              {i + 1}. → {edge.to}{" "}
              <span className="text-outline">when {describeCondition(edge.when)}</span>
              {edge.label && <span className="text-outline"> ({edge.label})</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Ledger({
  run,
  selectedNodeId,
  onSelectNode,
}: {
  run: FlowRun;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="font-label text-[10px] uppercase tracking-widest text-outline">
        Ledger ({run.nodes.length} {run.nodes.length === 1 ? "visit" : "visits"})
      </div>
      {run.nodes.length === 0 ? (
        <div className="font-body text-xs text-outline">Nothing has run yet.</div>
      ) : (
        <div className="space-y-1">
          {run.nodes.map((nodeRun, index) => (
            // biome-ignore lint/a11y/noStaticElementInteractions: row selection wrapping a session link
            <div
              key={`${nodeRun.node_id}-${nodeRun.attempt}-${nodeRun.retry}`}
              onClick={() => onSelectNode(nodeRun.node_id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onSelectNode(nodeRun.node_id);
              }}
              data-testid="flow-ledger-row"
              data-node-id={nodeRun.node_id}
              data-node-status={nodeRun.status}
              data-node-outcome={nodeRun.outcome ?? ""}
              className={`w-full text-left p-2 rounded-sm border transition-colors cursor-pointer ${
                selectedNodeId === nodeRun.node_id
                  ? "border-primary/40 bg-primary/5"
                  : "border-surface-highest bg-surface-highest/40 hover:bg-surface-highest/70"
              }`}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-label text-[9px] text-outline">{index + 1}</span>
                <span className="font-body text-xs text-on-surface">{nodeRun.node_id}</span>
                <span className="font-label text-[9px] text-outline">
                  visit {nodeRun.attempt}
                  {nodeRun.retry > 0 ? ` · retry ${nodeRun.retry}` : ""}
                </span>
                <span
                  className={`font-label text-[9px] uppercase tracking-wider ${
                    NODE_STATUS_COLORS[nodeRun.status] ?? "text-outline"
                  }`}
                >
                  {nodeRun.status.replace(/_/g, " ")}
                </span>
                {nodeRun.outcome && (
                  <span className="font-label text-[9px] text-primary">→ {nodeRun.outcome}</span>
                )}
                {/* A queued or parked node has no started_at, so fall back to
                    when the row was written - the same COALESCE the runner uses
                    to decide how long a gate has been waiting. */}
                <span className="font-label text-[9px] text-outline ml-auto">
                  {formatDuration(nodeRun.started_at ?? nodeRun.created_at, nodeRun.ended_at)}
                  {nodeRun.started_at === null && isLive(nodeRun.status) ? " waiting" : ""}
                </span>
              </div>
              {nodeRun.summary && (
                <div className="font-body text-[11px] text-on-surface-variant mt-1 whitespace-pre-wrap">
                  {nodeRun.summary}
                </div>
              )}
              {nodeRun.error && (
                <div className="font-body text-[11px] text-error mt-1 whitespace-pre-wrap">
                  {nodeRun.error}
                </div>
              )}
              {nodeRun.gateway_session_id && (
                <Link
                  to={`/sessions/${nodeRun.gateway_session_id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="font-mono text-[10px] text-primary hover:underline mt-1 inline-block"
                  data-testid="flow-ledger-session-link"
                >
                  session {nodeRun.gateway_session_id.slice(-8)}
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Header used by the task sheet so the section reads as one thing. */
export function FlowSectionHeading({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 font-label text-[10px] uppercase tracking-widest text-outline">
      <GitBranch size={12} />
      Flow
      {children}
    </div>
  );
}
