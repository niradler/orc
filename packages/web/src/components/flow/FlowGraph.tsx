import { useMemo } from "react";
import {
  type FlowGraphDefinition,
  type LaidOutEdge,
  type LaidOutNode,
  layoutFlowGraph,
  NODE_H,
  NODE_W,
  type NodeLedgerState,
} from "@/lib/flow-graph";

/** How a node is drawn. Derived from the ledger, or `idle` with no ledger at all. */
export type NodeVisualState = "idle" | "active" | "awaiting_human" | "succeeded" | "failed";

const KIND_GLYPH: Record<string, string> = {
  agent: "▶",
  gate: "◆",
  human: "☻",
  terminal: "■",
};

const STATE_STYLE: Record<NodeVisualState, { box: string; title: string; sub: string }> = {
  idle: {
    box: "fill-surface stroke-outline-variant",
    title: "fill-on-surface-variant",
    sub: "fill-outline",
  },
  active: {
    box: "fill-primary/10 stroke-primary",
    title: "fill-primary",
    sub: "fill-on-surface-variant",
  },
  awaiting_human: {
    box: "fill-tertiary/10 stroke-tertiary",
    title: "fill-tertiary",
    sub: "fill-on-surface-variant",
  },
  succeeded: {
    box: "fill-secondary/5 stroke-secondary/60",
    title: "fill-secondary",
    sub: "fill-outline",
  },
  failed: {
    box: "fill-error/10 stroke-error",
    title: "fill-error",
    sub: "fill-on-surface-variant",
  },
};

export function visualState(state: NodeLedgerState | undefined): NodeVisualState {
  if (!state) return "idle";
  if (state.status === "awaiting_human") return "awaiting_human";
  if (state.status === "pending" || state.status === "running") return "active";
  if (state.status === "failed" || state.status === "cancelled") return "failed";
  if (state.status === "succeeded") return "succeeded";
  return "idle";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function nodeSubtitle(node: LaidOutNode, state: NodeLedgerState | undefined): string {
  if (state?.outcome) return `→ ${state.outcome}`;
  if (node.kind === "agent") return node.skill ?? node.role ?? "agent";
  if (node.kind === "terminal") return node.task_status ?? "end";
  if (node.join) return `join ${node.join.mode}`;
  if (node.routing === "all") return "fan out";
  return node.kind;
}

interface FlowGraphProps {
  definition: FlowGraphDefinition;
  /** Absent while a flow has never run - every node then draws as `idle`. */
  states?: Record<string, NodeLedgerState>;
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string) => void;
}

export function FlowGraph({ definition, states, selectedNodeId, onSelectNode }: FlowGraphProps) {
  const layout = useMemo(() => layoutFlowGraph(definition), [definition]);

  return (
    <div
      className="overflow-x-auto border border-surface-highest rounded-sm bg-surface-low"
      data-testid="flow-graph"
      data-flow-name={definition.name}
    >
      <svg
        role="img"
        aria-label={`Flow graph for ${definition.name}`}
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        style={{ minWidth: layout.width }}
      >
        <defs>
          <marker
            id="flow-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" className="fill-outline" />
          </marker>
          <marker
            id="flow-arrow-loop"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" className="fill-tertiary" />
          </marker>
        </defs>

        {layout.edges.map((edge) => (
          <EdgePath key={`${edge.index}-${edge.from}-${edge.to}`} edge={edge} />
        ))}

        {layout.nodes.map((node) => (
          <NodeBox
            key={node.id}
            node={node}
            state={states?.[node.id]}
            isEntry={node.id === definition.entry}
            selected={selectedNodeId === node.id}
            {...(onSelectNode ? { onSelect: onSelectNode } : {})}
          />
        ))}
      </svg>
    </div>
  );
}

function EdgePath({ edge }: { edge: LaidOutEdge }) {
  if (!edge.path) return null;
  const isLoop = edge.kind !== "forward";
  return (
    <g
      data-testid="flow-graph-edge"
      data-edge-from={edge.from}
      data-edge-to={edge.to}
      data-edge-kind={edge.kind}
    >
      <path
        d={edge.path}
        fill="none"
        strokeWidth={1.25}
        className={isLoop ? "stroke-tertiary/70" : "stroke-outline"}
        {...(isLoop ? { strokeDasharray: "4 3" } : {})}
        markerEnd={isLoop ? "url(#flow-arrow-loop)" : "url(#flow-arrow)"}
      />
      {edge.text && (
        <text
          x={edge.labelX}
          y={edge.labelY}
          textAnchor="middle"
          className={`font-label text-[9px] ${isLoop ? "fill-tertiary/90" : "fill-outline"}`}
        >
          {truncate(edge.text, 26)}
        </text>
      )}
    </g>
  );
}

function NodeBox({
  node,
  state,
  isEntry,
  selected,
  onSelect,
}: {
  node: LaidOutNode;
  state: NodeLedgerState | undefined;
  isEntry: boolean;
  selected: boolean;
  onSelect?: (nodeId: string) => void;
}) {
  const visual = visualState(state);
  const style = STATE_STYLE[visual];
  const radius = node.kind === "terminal" ? 14 : 4;
  const budget = node.max_visits ? `${state?.visits ?? 0}/${node.max_visits}` : null;
  const visits = state && state.visits > 1 ? `×${state.visits}` : null;

  return (
    <g
      data-testid="flow-graph-node"
      data-node-id={node.id}
      data-node-kind={node.kind}
      data-node-state={visual}
      transform={`translate(${node.x} ${node.y})`}
      className={onSelect ? "cursor-pointer" : undefined}
      {...(onSelect
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": `Node ${node.id} (${node.kind})`,
            onClick: () => onSelect(node.id),
            onKeyDown: (e: React.KeyboardEvent<SVGGElement>) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(node.id);
              }
            },
          }
        : {})}
    >
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={radius}
        strokeWidth={selected ? 2 : 1.25}
        className={`${style.box} ${selected ? "stroke-on-surface" : ""}`}
      />
      <text x={10} y={20} className={`font-label text-[10px] ${style.sub}`}>
        {KIND_GLYPH[node.kind] ?? "•"}
      </text>
      <text x={26} y={21} className={`font-body text-[12px] font-medium ${style.title}`}>
        {truncate(node.id, 18)}
      </text>
      <text x={10} y={38} className={`font-body text-[10px] ${style.sub}`}>
        {truncate(nodeSubtitle(node, state), 24)}
      </text>
      <text x={10} y={50} className="font-label text-[9px] fill-outline">
        {[isEntry ? "entry" : null, budget ? `visits ${budget}` : visits, node.task_status]
          .filter(Boolean)
          .join(" · ")}
      </text>
      {state?.latest.error && (
        <text x={NODE_W - 8} y={20} textAnchor="end" className="font-label text-[10px] fill-error">
          !
        </text>
      )}
    </g>
  );
}

export function FlowGraphLegend() {
  const items: Array<[NodeVisualState, string]> = [
    ["active", "running"],
    ["awaiting_human", "awaiting human"],
    ["succeeded", "done"],
    ["failed", "failed"],
    ["idle", "not visited"],
  ];
  return (
    <div className="flex flex-wrap items-center gap-3 mt-2">
      {items.map(([state, label]) => (
        <span key={state} className="flex items-center gap-1.5">
          <svg width={10} height={10} aria-hidden="true">
            <rect
              width={10}
              height={10}
              rx={2}
              strokeWidth={1.5}
              className={STATE_STYLE[state].box}
            />
          </svg>
          <span className="font-label text-[9px] uppercase tracking-widest text-outline">
            {label}
          </span>
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <svg width={16} height={10} aria-hidden="true">
          <line
            x1={0}
            y1={5}
            x2={16}
            y2={5}
            strokeWidth={1.25}
            strokeDasharray="4 3"
            className="stroke-tertiary/70"
          />
        </svg>
        <span className="font-label text-[9px] uppercase tracking-widest text-outline">
          loopback
        </span>
      </span>
    </div>
  );
}
