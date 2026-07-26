import { AlertTriangle, Search } from "lucide-react";
import { useState } from "react";
import type { FlowSource } from "@/api/client";
import { DetailField } from "@/components/DetailField";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { FlowGraph } from "@/components/flow/FlowGraph";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ViewHeader } from "@/components/ViewHeader";
import { useDetailRoute } from "@/hooks/useDetailRoute";
import { useFlow, useFlows } from "@/hooks/useFlows";
import { describeCondition, toFlowDefinition } from "@/lib/flow-graph";

type SourceFilter = "all" | FlowSource;

const SOURCE_FILTERS: Array<{ value: SourceFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "builtin", label: "Built-in" },
  { value: "user", label: "User" },
  { value: "project", label: "Project" },
];

const SOURCE_COLORS: Record<FlowSource, string> = {
  builtin: "bg-primary/15 text-primary border-primary/30",
  user: "bg-tertiary/15 text-tertiary border-tertiary/30",
  project: "bg-secondary/15 text-secondary border-secondary/30",
};

export default function Flows() {
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const {
    selectedId: selectedFlow,
    openDetail,
    closeDetail,
  } = useDetailRoute("/flows", "flowName");

  const { data, isLoading, error, refetch } = useFlows(
    sourceFilter === "all" ? undefined : { source: sourceFilter },
  );

  if (error) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;

  const flows = (data?.flows ?? []).filter((f) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return f.name.toLowerCase().includes(q) || f.description.toLowerCase().includes(q);
  });
  const broken = data?.broken ?? [];

  return (
    <div>
      <ViewHeader title="Flows" meta={`${flows.length} flows`} />

      <div className="flex items-center gap-4 mb-4">
        <div className="flex gap-1.5">
          {SOURCE_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              data-testid={`flow-source-filter-${f.value}`}
              onClick={() => setSourceFilter(f.value)}
              className={`font-label text-[10px] uppercase tracking-widest px-3 py-1.5 border transition-colors ${
                sourceFilter === f.value
                  ? "bg-primary/15 text-primary border-primary/30"
                  : "bg-surface-highest border-surface-highest text-outline hover:text-on-surface-variant"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1">
          <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-outline" />
          <Input
            data-testid="flow-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search flows..."
            className="pl-8 bg-surface-highest border-surface-highest text-on-surface font-body text-xs placeholder:text-outline"
          />
        </div>
      </div>

      {/* Definitions that failed validation. The API reports these rather than
          skipping them silently, so a flow that will never run is visible here
          instead of only surfacing when a task tries to start it. */}
      {broken.length > 0 && (
        <div
          className="mb-4 border border-error/40 rounded-sm bg-error/5"
          data-testid="broken-flows"
        >
          <div className="flex items-center gap-1.5 px-3 py-2 border-b border-error/20 font-label text-[10px] uppercase tracking-widest text-error">
            <AlertTriangle size={12} />
            {broken.length} invalid {broken.length === 1 ? "flow" : "flows"}
          </div>
          <div className="divide-y divide-error/10">
            {broken.map((b) => (
              <div
                key={b.path || b.name}
                className="px-3 py-2 space-y-1"
                data-testid="broken-flow-row"
                data-flow-name={b.name}
              >
                <div className="flex items-center gap-2">
                  <span className="font-body text-xs text-on-surface">{b.name}</span>
                  <code className="font-mono text-[10px] text-outline break-all">{b.path}</code>
                </div>
                <ul className="space-y-0.5">
                  {b.errors.map((err) => (
                    <li
                      key={err}
                      className="font-body text-[11px] text-error"
                      data-testid="broken-flow-error"
                    >
                      {err}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-10 w-full bg-surface-highest" />
          ))}
        </div>
      ) : flows.length === 0 ? (
        <EmptyState message={search ? "No flows match your search" : "No flows found"} />
      ) : (
        <div className="border border-surface-highest rounded-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-surface-highest hover:bg-transparent">
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">
                  Name
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">
                  Description
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-44">
                  Source
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-20">
                  Shape
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {flows.map((flow) => (
                <TableRow
                  key={`${flow.source}-${flow.name}`}
                  data-testid="flow-row"
                  data-flow-name={flow.name}
                  data-flow-source={flow.source}
                  className="border-b border-surface-highest/50 hover:bg-surface-low cursor-pointer"
                  onClick={() => openDetail(flow.name)}
                >
                  <TableCell className="font-body text-xs font-medium text-on-surface">
                    <div className="flex items-center gap-1.5">
                      {flow.name}
                      {flow.name === data?.default_flow && (
                        <span
                          data-testid="flow-default-badge"
                          className="px-1.5 py-0.5 font-label text-[9px] uppercase tracking-wider border bg-surface-highest border-outline-variant text-on-surface-variant"
                        >
                          default
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="font-body text-xs text-outline max-w-md truncate">
                    {flow.description || "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <span
                        className={`inline-flex px-2 py-0.5 font-label text-[10px] uppercase tracking-wider border ${SOURCE_COLORS[flow.source]}`}
                      >
                        {flow.source}
                      </span>
                      {flow.shadows && (
                        <span
                          data-testid="flow-shadows-badge"
                          className="inline-flex px-2 py-0.5 font-label text-[10px] uppercase tracking-wider border bg-surface-highest border-outline-variant text-on-surface-variant"
                        >
                          shadows {flow.shadows}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="font-label text-[10px] text-outline whitespace-nowrap">
                    {flow.node_count}n · {flow.edge_count}e
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <FlowDetailSheet flowName={selectedFlow} open={Boolean(selectedFlow)} onClose={closeDetail} />
    </div>
  );
}

function FlowDetailSheet({
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
                    className={`inline-flex px-2 py-0.5 font-label text-[10px] uppercase tracking-wider border ${SOURCE_COLORS[flow.source]}`}
                  >
                    {flow.source}
                  </span>
                </DetailField>
                <DetailField label="Entry">
                  <code className="font-mono text-[10px]">{definition.entry}</code>
                </DetailField>
                <DetailField label="Version">{definition.version}</DetailField>
                <DetailField label="Path">
                  <code className="font-mono text-[10px] text-outline break-all">
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
                <div className="font-label text-[10px] uppercase tracking-widest text-outline">
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
                      <span className="font-label text-[9px] uppercase tracking-wider text-outline">
                        {node.kind}
                      </span>
                      {node.skill && (
                        <span className="font-mono text-[10px] text-primary">{node.skill}</span>
                      )}
                      {node.task_status && (
                        <span className="font-label text-[9px] uppercase text-outline">
                          sets {node.task_status}
                        </span>
                      )}
                      {node.max_visits !== undefined && (
                        <span className="font-label text-[9px] uppercase text-outline">
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
                <div className="font-label text-[10px] uppercase tracking-widest text-outline">
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
                      className="font-mono text-[10px] text-on-surface-variant"
                    >
                      {index + 1}. {edge.from} → {edge.to}{" "}
                      <span className="text-outline">when {describeCondition(edge.when)}</span>
                    </div>
                  ))}
              </div>

              <div>
                <div className="font-label text-[10px] uppercase tracking-widest text-outline mb-2">
                  Definition
                </div>
                <div className="border border-surface-highest rounded-sm overflow-hidden">
                  <ScrollArea className="h-[300px]">
                    <pre className="font-mono text-[11px] leading-relaxed bg-background p-4 whitespace-pre-wrap break-words text-on-surface">
                      {JSON.stringify(flow.definition, null, 2)}
                    </pre>
                  </ScrollArea>
                </div>
              </div>
            </div>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
