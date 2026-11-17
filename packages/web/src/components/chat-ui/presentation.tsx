import {
  CircleCheck,
  CircleX,
  Info,
  Minus,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";
import { fullNumber } from "@/lib/chat-ui-chart";
import { cn } from "@/lib/utils";
import { ProgressBar } from "./primitives";

const TREND_ICON = { up: TrendingUp, down: TrendingDown, flat: Minus } as const;
const TREND_WORD = { up: "Trending up", down: "Trending down", flat: "Flat" } as const;

/** One big number reads as content, not a KPI card: label, figure, quiet hint. */
export function Metric({
  label,
  value,
  unit,
  hint,
  trend,
}: {
  label: string;
  value: string | number;
  unit?: string;
  hint?: string;
  trend?: "up" | "down" | "flat";
}) {
  const Icon = trend ? TREND_ICON[trend] : null;
  return (
    <div data-testid="chat-ui-metric" className="min-w-0">
      <p className="break-words text-xs text-on-surface-variant" title={label}>
        {label}
      </p>
      <p className="mt-0.5 flex min-w-0 items-baseline gap-1">
        <span className="text-2xl font-medium tabular-nums break-words text-on-surface">
          {typeof value === "number" ? fullNumber(value) : value}
        </span>
        {unit && <span className="text-sm text-on-surface-variant">{unit}</span>}
      </p>
      {(hint || trend) && (
        <p className="mt-0.5 flex items-center gap-1 text-xs text-on-surface-variant">
          {Icon && (
            <>
              <Icon data-testid="chat-ui-metric-trend" size={12} aria-hidden="true" />
              <span className="sr-only">{TREND_WORD[trend ?? "flat"]}: </span>
            </>
          )}
          {hint && <span className="min-w-0 break-words">{hint}</span>}
        </p>
      )}
    </div>
  );
}

export function Progress({ value, label }: { value: number; label?: string }) {
  return (
    <div data-testid="chat-ui-progress" className="min-w-0 max-w-md">
      <ProgressBar value={value} label={label} />
    </div>
  );
}

/** Spec rows carry no ids; positional keys stay stable because the data never reorders. */
function indexed(values: string[]) {
  return values.map((value, index) => ({ key: `${index}:${value}`, value }));
}

/** Cells wrap so a phone reader sees the full value; only wide screens cap the column. */
export function Table({
  columns,
  rows,
  caption,
}: {
  columns: string[];
  rows: string[][];
  caption?: string;
}) {
  const header = indexed(columns);
  const body = rows.map((row, index) => ({ key: `row-${index}`, cells: indexed(row) }));
  return (
    <figure data-testid="chat-ui-table" className="min-w-0">
      {caption && (
        <figcaption className="mb-1 break-words text-xs text-on-surface-variant" title={caption}>
          {caption}
        </figcaption>
      )}
      <section
        aria-label={caption ?? "Table"}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a sideways-scrolling table needs keyboard focus
        tabIndex={0}
        data-testid="chat-ui-table-scroll"
        className="max-w-full overflow-x-auto overscroll-x-contain rounded-sm focus-visible:outline-2 focus-visible:outline-focus"
      >
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-outline-variant text-left text-xs text-on-surface-variant">
              {header.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className="whitespace-nowrap py-1.5 pr-4 font-normal last:pr-0"
                >
                  {column.value}
                </th>
              ))}
            </tr>
          </thead>
          {body.length === 0 ? (
            <tbody>
              <tr>
                <td
                  data-testid="chat-ui-table-empty"
                  colSpan={header.length}
                  className="py-1.5 text-xs text-on-surface-variant"
                >
                  No rows
                </td>
              </tr>
            </tbody>
          ) : (
            <tbody className="divide-y divide-outline-variant">
              {body.map((row) => (
                <tr key={row.key}>
                  {row.cells.map((cell) => (
                    <td
                      key={cell.key}
                      title={cell.value.length > 32 ? cell.value : undefined}
                      className="min-w-24 max-w-none break-words py-1.5 pr-4 align-top text-on-surface last:pr-0 md:max-w-56"
                    >
                      {cell.value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          )}
        </table>
      </section>
    </figure>
  );
}

/** Compact definition list: labels stay quiet, values stay readable. */
export function KeyValue({
  items,
  title,
}: {
  items: { label: string; value: string }[];
  title?: string;
}) {
  const entries = items.map((item, index) => ({ ...item, key: `${index}:${item.label}` }));
  return (
    <div data-testid="chat-ui-key-value" className="min-w-0">
      {title && <p className="truncate text-xs text-on-surface-variant">{title}</p>}
      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        {entries.map((item) => (
          <div key={item.key} className="contents">
            <dt className="min-w-0 break-words text-on-surface-variant">{item.label}</dt>
            <dd className="min-w-0 break-words text-on-surface">{item.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const CALLOUT = {
  info: { Icon: Info, color: "text-progress" },
  warn: { Icon: TriangleAlert, color: "text-tertiary" },
  error: { Icon: CircleX, color: "text-error" },
  done: { Icon: CircleCheck, color: "text-secondary" },
} as const;
const CALLOUT_WORD = { info: "Info", warn: "Warning", error: "Error", done: "Done" } as const;

export function Callout({
  tone,
  text,
  title,
}: {
  tone: keyof typeof CALLOUT;
  text: string;
  title?: string;
}) {
  const { Icon, color } = CALLOUT[tone];
  return (
    <div
      data-testid="chat-ui-callout"
      data-tone={tone}
      className="flex min-w-0 gap-2 rounded-md border border-outline-variant px-3 py-2"
    >
      <Icon aria-hidden="true" size={16} className={cn("mt-0.5 shrink-0", color)} />
      <div className="min-w-0 text-sm">
        <span className="sr-only">{CALLOUT_WORD[tone]}: </span>
        {title && <p className="break-words font-medium text-on-surface">{title}</p>}
        <p className="break-words text-on-surface">{text}</p>
      </div>
    </div>
  );
}
