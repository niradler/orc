import { type Components, defineRegistry } from "@json-render/react";
import { chatUiCatalog } from "@orc/core/chat-ui";
import { lazy, Suspense } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { JobCard, ScratchpadCard, SessionList, TaskCard, TaskList } from "./entities";
import { HtmlBlock } from "./HtmlBlock";
import { Callout, KeyValue, Metric, Progress, Table } from "./presentation";
import { SessionUsageCard } from "./SessionUsageCard";

// Recharts only loads when an answer actually charts something.
const Chart = lazy(() => import("./Chart"));
const Sparkline = lazy(() => import("./Chart").then((module) => ({ default: module.Sparkline })));
const ChartFallback = () => <div className="h-56 w-full" aria-hidden="true" />;
// Same caption line plus 2rem plot as the real sparkline, so lazy loading does not shift the answer.
const SparklineFallback = () => (
  <div className="min-w-0" aria-hidden="true">
    <div className="h-4 w-24" />
    <div className="h-8 w-40 max-w-full" />
  </div>
);

const GAP = { sm: "gap-1.5", md: "gap-3", lg: "gap-5" } as const;
const BUTTON_VARIANT = {
  primary: "default",
  secondary: "outline",
  destructive: "destructive",
} as const;

const components: Components<typeof chatUiCatalog> = {
  Stack: ({ props, children }) => (
    <div
      className={cn(
        "flex min-w-0",
        props.direction === "horizontal" ? "flex-row flex-wrap items-center" : "flex-col",
        GAP[props.gap ?? "md"],
      )}
    >
      {children}
    </div>
  ),
  Button: ({ props, emit, loading }) => (
    <Button
      type="button"
      size="sm"
      className="w-fit"
      data-testid="chat-ui-button"
      variant={BUTTON_VARIANT[props.variant ?? "secondary"]}
      disabled={loading}
      onClick={() => emit("press")}
    >
      {props.label}
    </Button>
  ),
  Task: ({ props }) => <TaskCard id={props.id} />,
  TaskList: ({ props }) => (
    <TaskList projectId={props.projectId} status={props.status} limit={props.limit} />
  ),
  Job: ({ props }) => <JobCard id={props.id} />,
  SessionList: ({ props }) => <SessionList projectId={props.projectId} limit={props.limit} />,
  Scratchpad: ({ props }) => <ScratchpadCard id={props.id} />,
  Metric: ({ props }) => (
    <Metric
      label={props.label}
      value={props.value}
      unit={props.unit}
      hint={props.hint}
      trend={props.trend}
    />
  ),
  Progress: ({ props }) => <Progress value={props.value} label={props.label} />,
  Table: ({ props }) => <Table columns={props.columns} rows={props.rows} caption={props.caption} />,
  Sparkline: ({ props }) => (
    <Suspense fallback={<SparklineFallback />}>
      <Sparkline values={props.values} label={props.label} />
    </Suspense>
  ),
  Chart: ({ props }) => (
    <Suspense fallback={<ChartFallback />}>
      <Chart kind={props.kind} labels={props.labels} series={props.series} title={props.title} />
    </Suspense>
  ),
  KeyValue: ({ props }) => <KeyValue items={props.items} title={props.title} />,
  Callout: ({ props }) => <Callout tone={props.tone} text={props.text} title={props.title} />,
  Html: ({ props }) => <HtmlBlock html={props.html} title={props.title} height={props.height} />,
  SessionUsage: ({ props }) => <SessionUsageCard sessionId={props.sessionId} />,
};

// Actions are dispatched through JSONUIProvider handlers (see ChatUiRenderer), which need
// React Query and the confirm dialog, so the static registry declares none.
type RegistryOptions = Parameters<typeof defineRegistry<typeof chatUiCatalog>>[1];
export const { registry } = defineRegistry(chatUiCatalog, {
  components,
} as unknown as RegistryOptions);
