import type { FlowSource } from "@/api/client";
import { CodeEditor } from "@/components/CodeEditor";
import { DetailField } from "@/components/DetailField";
import { FlowGraph } from "@/components/flow/FlowGraph";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useFlow } from "@/hooks/useFlows";
import { describeCondition, toFlowDefinition } from "@/lib/flow-graph";

const SOURCE_COLORS: Record<FlowSource, string> = {
  builtin: "bg-primary/15 text-primary border-primary/30",
  user: "bg-tertiary/15 text-tertiary border-tertiary/30",
  project: "bg-secondary/15 text-secondary border-secondary/30",
};

/**
 * Read-only view of one flow definition: graph, limits, nodes, edges and the raw
 * JSON. Opened from the flow picker (before choosing a flow for a task) and from
 * a task's flow run panel.
 */
export function FlowDetailSheet({
  flowName,
  open,
  onClose,
}: {
  flowName: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const { data: flow, isLoading, error } = useFlow(flowName);
  const definition = flow ? toFlowDefinition(flow.definition) : null;

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      {/* Wider than the default sheet: this view exists to show a graph, and the
          shipped flows are up to five layers across. */}
      <SheetContent className="w-[880px] max-w-[95vw]">
        <SheetHeader>
          <SheetTitle>{flow?.name ?? flowName ?? "Flow"}</SheetTitle>
          {flow?.description && (
            <p className="font-body text-xs text-outline mt-1">{flow.description}</p>
          )}
        </SheetHeader>
        <SheetBody>
          {error ? (
            <div className="font-body text-xs text-error">{(error as Error).message}</div>
          ) : isLoading || !flow || !definition ? (
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
                <Skeleton key={i} className="h-8 w-full bg-surface-highest" />
              ))}
            </div>
          ) : (
            <div className="space-y-6" data-testid="flow-detail">
              <FlowGraph definition={definition} />

              <div className="grid grid-cols-2 gap-4">
                <DetailField label="Source">
                  <span
                    className={`inline-flex px-2 py-0.5 font-label text-[11px] uppercase tracking-wider border ${SOURCE_COLORS[flow.source]}`}
                  >
                    {flow.source}
                  </span>
                </DetailField>
                <DetailField label="Entry">
                  <code className="font-mono text-[11px]">{definition.entry}</code>
                </DetailField>
                <DetailField label="Version">{definition.version}</DetailField>
                <DetailField label="Path">
                  <code className="font-mono text-[11px] text-outline break-all">
                    {flow.path ?? "compiled in"}
                  </code>
                </DetailField>
                <DetailField label="Max node executions">
                  {definition.limits.max_node_executions ?? "—"}
                </DetailField>
                <DetailField label="Timeout">
                  {definition.limits.execution_timeout_secs
                    ? `${definition.limits.execution_timeout_secs}s`
                    : "—"}
                </DetailField>
                <DetailField label="Max parallel">
                  {definition.limits.max_parallel ?? "—"}
                </DetailField>
                <DetailField label="Halt status">
                  {definition.limits.halt_task_status ?? "—"}
                </DetailField>
              </div>

              <div className="space-y-1">
                <div className="font-label text-[11px] uppercase tracking-widest text-outline">
                  Nodes ({definition.nodes.length})
                </div>
                {definition.nodes.map((node) => (
                  <div
                    key={node.id}
                    data-testid="flow-detail-node"
                    data-node-id={node.id}
                    className="p-2 border border-surface-highest rounded-sm space-y-1"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-body text-xs text-on-surface">{node.id}</span>
                      <span className="font-label text-[10px] uppercase tracking-wider text-outline">
                        {node.kind}
                      </span>
                      {node.skill && (
                        <span className="font-mono text-[11px] text-primary">{node.skill}</span>
                      )}
                      {node.task_status && (
                        <span className="font-label text-[10px] uppercase text-outline">
                          sets {node.task_status}
                        </span>
                      )}
                      {node.max_visits !== undefined && (
                        <span className="font-label text-[10px] uppercase text-outline">
                          max {node.max_visits} visits
                        </span>
                      )}
                    </div>
                    {node.description && (
                      <div className="font-body text-[11px] text-on-surface-variant">
                        {node.description}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="space-y-1">
                <div className="font-label text-[11px] uppercase tracking-widest text-outline">
                  Edges ({definition.edges.length}) — evaluated in order
                </div>
                {/* Keyed by position: an edge has no id, two edges may share
                    from/to and differ only in `when`, and the order is the
                    routing order. */}
                {definition.edges
                  .map((edge, index) => ({ edge, index }))
                  .map(({ edge, index }) => (
                    <div
                      key={index}
                      data-testid="flow-detail-edge"
                      className="font-mono text-[11px] text-on-surface-variant"
                    >
                      {index + 1}. {edge.from} → {edge.to}{" "}
                      <span className="text-outline">when {describeCondition(edge.when)}</span>
                    </div>
                  ))}
              </div>

              <div>
                <div className="font-label text-[11px] uppercase tracking-widest text-outline mb-2">
                  Definition
                </div>
                <div className="border border-surface-highest rounded-sm overflow-hidden">
                  <CodeEditor
                    path="flow.json"
                    value={JSON.stringify(flow.definition, null, 2)}
                    readOnly
                    height={300}
                    testId="flow-file-content"
                  />
                </div>
              </div>
            </div>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
