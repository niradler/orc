import { type Components, defineRegistry } from "@json-render/react";
import { chatUiCatalog, isChatUiHref } from "@orc/core/chat-ui";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  JobCard,
  JobList,
  MemoryCard,
  PadCard,
  ProjectCard,
  ProjectList,
  SessionList,
  SkillCard,
  TaskCard,
  TaskList,
} from "./entities";
import { Dot, Panel, ProgressBar, UiLink } from "./primitives";

type Cell = string | number | boolean | null | undefined;

const GAP = { sm: "gap-1.5", md: "gap-3", lg: "gap-5" } as const;
const GRID = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
} as const;
const ALERT_TONE = {
  info: "progress",
  success: "success",
  warning: "warning",
  error: "error",
} as const;
const BUTTON_VARIANT = {
  primary: "default",
  secondary: "outline",
  destructive: "destructive",
} as const;

function cellText(value: Cell): string {
  if (value == null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function safeHref(value: Cell): string | null {
  return typeof value === "string" && isChatUiHref(value) ? value : null;
}

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
  Grid: ({ props, children }) => (
    <div className={cn("grid min-w-0 gap-3", GRID[(props.columns ?? 2) as keyof typeof GRID])}>
      {children}
    </div>
  ),
  Card: ({ props, children }) => (
    <Panel testId="chat-ui-card" className="flex flex-col gap-2">
      {(props.title || props.description) && (
        <header className="min-w-0">
          {props.title && <h3 className="text-sm font-medium text-on-surface">{props.title}</h3>}
          {props.description && (
            <p className="text-xs text-on-surface-variant">{props.description}</p>
          )}
        </header>
      )}
      {children}
    </Panel>
  ),
  Heading: ({ props }) =>
    props.level === 3 ? (
      <h4 className="text-xs font-medium uppercase tracking-wide text-on-surface-variant">
        {props.text}
      </h4>
    ) : (
      <h3 className="text-sm font-medium text-on-surface">{props.text}</h3>
    ),
  Text: ({ props }) => (
    <p className={cn("text-sm", props.muted ? "text-on-surface-variant" : "text-on-surface")}>
      {props.text}
    </p>
  ),
  Markdown: ({ props }) => <Markdown>{props.text}</Markdown>,
  Badge: ({ props }) => (
    <span className="inline-flex w-fit items-center gap-1.5 text-xs text-on-surface-variant">
      <Dot tone={props.tone ?? "neutral"} />
      {props.label}
    </span>
  ),
  KeyValue: ({ props }) => (
    <dl className="grid min-w-0 grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1.5 text-xs">
      {props.items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-on-surface-variant">{item.label}</dt>
          <dd className="min-w-0 break-words text-on-surface">
            {item.href ? (
              <UiLink href={item.href}>{cellText(item.value)}</UiLink>
            ) : (
              cellText(item.value)
            )}
          </dd>
        </div>
      ))}
    </dl>
  ),
  Stat: ({ props }) => (
    <div className="min-w-0">
      <p className="text-xs text-on-surface-variant">{props.label}</p>
      <p className="text-lg font-medium tabular-nums text-on-surface">{props.value}</p>
      {props.hint && <p className="text-xs text-on-surface-variant">{props.hint}</p>}
    </div>
  ),
  Table: ({ props }) => (
    <div className="min-w-0 overflow-x-auto" data-testid="chat-ui-table">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-outline-variant text-on-surface-variant">
            {props.columns.map((column) => (
              <th key={column.key} scope="col" className="px-2 py-1.5 font-normal first:pl-0">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-outline-variant">
          {props.rows.map((row, index) => {
            const href = props.linkKey ? safeHref(row[props.linkKey]) : null;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are static spec data without ids
              <tr key={index} className="text-on-surface">
                {props.columns.map((column, columnIndex) => (
                  <td key={column.key} className="px-2 py-1.5 align-top first:pl-0">
                    {columnIndex === 0 && href ? (
                      <UiLink href={href}>{cellText(row[column.key])}</UiLink>
                    ) : (
                      cellText(row[column.key])
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  ),
  Progress: ({ props }) => <ProgressBar value={props.value} label={props.label} />,
  Alert: ({ props }) => (
    <div
      role={props.tone === "error" ? "alert" : "status"}
      className="flex min-w-0 gap-2 rounded-md border border-outline-variant px-3 py-2"
    >
      <Dot tone={ALERT_TONE[props.tone ?? "info"]} className="mt-1.5" />
      <div className="min-w-0">
        <p className="text-sm text-on-surface">{props.title}</p>
        {props.text && <p className="text-xs text-on-surface-variant">{props.text}</p>}
      </div>
    </div>
  ),
  Link: ({ props }) => <UiLink href={props.href}>{props.label}</UiLink>,
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
  Divider: () => <hr className="border-outline-variant" />,
  Code: ({ props }) => (
    <pre className="min-w-0 overflow-x-auto rounded-md bg-surface px-3 py-2 text-xs">
      <code>{props.code}</code>
    </pre>
  ),
  Task: ({ props }) => <TaskCard id={props.id} />,
  TaskList: ({ props }) => (
    <TaskList projectId={props.projectId} status={props.status} limit={props.limit} />
  ),
  Job: ({ props }) => <JobCard id={props.id} />,
  JobList: ({ props }) => (
    <JobList projectId={props.projectId} enabled={props.enabled} limit={props.limit} />
  ),
  Project: ({ props }) => <ProjectCard id={props.id} />,
  ProjectList: ({ props }) => <ProjectList status={props.status} limit={props.limit} />,
  SessionList: ({ props }) => <SessionList projectId={props.projectId} limit={props.limit} />,
  Memory: ({ props }) => <MemoryCard projectId={props.projectId} name={props.name} />,
  Pad: ({ props }) => <PadCard id={props.id} />,
  Skill: ({ props }) => <SkillCard name={props.name} />,
};

// Actions are dispatched through JSONUIProvider handlers (see ChatUiRenderer), which need
// React Query and the confirm dialog, so the static registry declares none.
type RegistryOptions = Parameters<typeof defineRegistry<typeof chatUiCatalog>>[1];
export const { registry } = defineRegistry(chatUiCatalog, {
  components,
} as unknown as RegistryOptions);
