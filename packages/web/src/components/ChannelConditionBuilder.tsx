import {
  type ChannelCondition,
  ChannelFields,
  ChannelOperators,
  type ChannelTimeWindow,
  validChannelCondition,
} from "@orc/core/channels";
import { X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Clause = Extract<ChannelCondition, { field: string }>;
type Node =
  | { id: string; type: "condition"; clause: Clause }
  | { id: string; type: "time"; window: ChannelTimeWindow }
  | { id: string; type: "all" | "any"; children: Node[] }
  | { id: string; type: "not"; child: Node };

const fields: Record<Clause["field"], string> = {
  sender: "Sender ID",
  chat: "Chat / channel ID",
  thread: "Thread ID",
  text: "Message text",
  command: "Command",
  is_direct: "Direct message",
  is_mention: "Mentions bot",
  is_followup: "Continues an answered thread",
  kind: "Event type",
};
const booleanFields = new Set<Clause["field"]>(["is_direct", "is_mention", "is_followup"]);
const listOperators = new Set<Clause["op"]>(["in", "contains_any"]);
const operators: Record<Clause["op"], string> = {
  is: "is",
  in: "is one of",
  contains: "contains",
  contains_any: "contains any of",
  starts_with: "starts with",
};
const negative: Record<Clause["op"], string> = {
  is: "is not",
  in: "is not one of",
  contains: "does not contain",
  contains_any: "contains none of",
  starts_with: "does not start with",
};
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const zones = (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf(
  "timeZone",
);
const control = "form-control form-control-single w-full";

function fromCondition(value: ChannelCondition): Node {
  const id = crypto.randomUUID();
  if ("all" in value) return { id, type: "all", children: value.all.map(fromCondition) };
  if ("any" in value) return { id, type: "any", children: value.any.map(fromCondition) };
  if ("not" in value) return { id, type: "not", child: fromCondition(value.not) };
  if ("always" in value) throw new Error("Otherwise rules have no conditions");
  if ("time" in value) return { id, type: "time", window: value.time };
  return { id, type: "condition", clause: value };
}

function toCondition(node: Node): ChannelCondition {
  if (node.type === "condition") return node.clause;
  if (node.type === "time") return { time: node.window };
  if (node.type === "not") return { not: toCondition(node.child) };
  return node.type === "all"
    ? { all: node.children.map(toCondition) }
    : { any: node.children.map(toCondition) };
}

function newCondition(): Node {
  return fromCondition({ field: "text", op: "contains", value: "" });
}

export function channelConditionSummary(value: unknown): string {
  if (!validChannelCondition(value)) return "Invalid conditions";
  if ("always" in value) return "Every remaining authorized message";
  if ("all" in value || "any" in value) {
    const children = "all" in value ? value.all : value.any;
    return `(${children.map(channelConditionSummary).join("all" in value ? " AND " : " OR ")})`;
  }
  if ("not" in value) {
    if ("field" in value.not) return clauseSummary(value.not, true);
    if ("time" in value.not) return timeSummary(value.not.time, true);
    return `NOT ${channelConditionSummary(value.not)}`;
  }
  if ("time" in value) return timeSummary(value.time);
  return clauseSummary(value);
}

function timeSummary(window: ChannelTimeWindow, excluded = false) {
  const days = window.days?.length ? window.days.map((d) => weekdays[d]).join(" ") : "every day";
  return `${excluded ? "Outside" : "Within"} ${window.from}–${window.to} ${days}${window.tz ? ` (${window.tz})` : ""}`;
}

function clauseSummary(clause: Clause, excluded = false) {
  const value = Array.isArray(clause.value)
    ? clause.value.join(", ")
    : typeof clause.value === "boolean"
      ? clause.value
        ? "Yes"
        : "No"
      : clause.value;
  return `${fields[clause.field]} ${excluded ? negative[clause.op] : operators[clause.op]} ${value || "“”"}`;
}

function NodeEditor({
  node,
  onChange,
  onRemove,
  depth = 0,
}: {
  node: Node;
  onChange: (node: Node) => void;
  onRemove?: () => void;
  depth?: number;
}) {
  const excluded = node.type === "not";
  const base = excluded ? node.child : node;
  const replace = (next: Node) => onChange(excluded ? { ...node, child: next } : next);
  const toggleExcluded = () =>
    onChange(excluded ? { ...base, id: node.id } : { id: node.id, type: "not", child: node });
  const actions = onRemove && (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={base.type === "condition" ? "Remove condition" : "Remove group"}
      title={base.type === "condition" ? "Remove condition" : "Remove group"}
      onClick={onRemove}
    >
      <X className="size-4" />
    </Button>
  );
  const rootAdd = !onRemove && depth === 0 && (
    <Button
      type="button"
      variant="ghost"
      onClick={() =>
        replace({ id: crypto.randomUUID(), type: "all", children: [base, newCondition()] })
      }
    >
      Add condition
    </Button>
  );
  if (base.type === "time")
    return (
      <TimeRow
        node={base}
        excluded={excluded}
        actions={
          <>
            {actions}
            {rootAdd}
          </>
        }
        onChange={(next, isNot) =>
          onChange(isNot ? { id: node.id, type: "not", child: next } : { ...next, id: node.id })
        }
      />
    );
  if (base.type === "not")
    return (
      <fieldset
        className="min-w-0 space-y-2 border-l-2 border-border pl-3"
        data-testid="channel-condition-group"
      >
        <legend className="text-sm">Exclude matches</legend>
        <Button type="button" variant="ghost" onClick={toggleExcluded}>
          Remove exclusion
        </Button>
        {actions}
        <NodeEditor node={base} onChange={replace} depth={depth + 1} />
      </fieldset>
    );
  if (base.type !== "condition")
    return (
      <fieldset
        className="min-w-0 space-y-2 border-l-2 border-border pl-3"
        data-testid="channel-condition-group"
      >
        <legend className="sr-only">Condition group</legend>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <select
            aria-label="Group match"
            className={`${control} max-w-52`}
            value={base.type}
            onChange={(event) => replace({ ...base, type: event.target.value as "all" | "any" })}
          >
            <option value="all">Match all (AND)</option>
            <option value="any">Match any (OR)</option>
          </select>
          <label className="inline-flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={excluded}
              onChange={toggleExcluded}
              disabled={!excluded && depth >= 5}
            />
            Exclude matches (NOT)
          </label>
          {actions}
        </div>
        <div className="space-y-3">
          {base.children.map((child) => (
            <NodeEditor
              key={child.id}
              node={child}
              depth={depth + (excluded ? 2 : 1)}
              onChange={(next) =>
                replace({
                  ...base,
                  children: base.children.map((item) => (item.id === child.id ? next : item)),
                })
              }
              onRemove={
                base.children.length > 1
                  ? () =>
                      replace({
                        ...base,
                        children: base.children.filter((item) => item.id !== child.id),
                      })
                  : undefined
              }
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            type="button"
            variant="ghost"
            disabled={depth + (excluded ? 1 : 0) >= 5}
            onClick={() => replace({ ...base, children: [...base.children, newCondition()] })}
          >
            Add condition
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={depth + (excluded ? 1 : 0) >= 4}
            onClick={() =>
              replace({
                ...base,
                children: [
                  ...base.children,
                  { id: crypto.randomUUID(), type: "any", children: [newCondition()] },
                ],
              })
            }
          >
            Add group
          </Button>
        </div>
      </fieldset>
    );
  const clause = base.clause;
  const boolean = booleanFields.has(clause.field);
  const updateClause = (next: Clause) => replace({ ...base, clause: next });
  const choices = boolean ? ["true", "false"] : ["message", "action"];
  const stringValue = Array.isArray(clause.value) ? clause.value.join(", ") : String(clause.value);
  return (
    <div className="space-y-1" data-testid="channel-condition-row">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] items-start gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)_auto]">
        <select
          aria-label="Condition field"
          className={control}
          title={fields[clause.field]}
          value={clause.field}
          onChange={(event) => {
            if (event.target.value === "time") {
              replace({
                id: base.id,
                type: "time",
                window: { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00", tz: localZone },
              });
              return;
            }
            const field = event.target.value as Clause["field"];
            updateClause({
              field,
              op: "is",
              value: booleanFields.has(field) ? true : field === "kind" ? "message" : "",
            });
          }}
        >
          <option value="time">Time of day</option>
          {ChannelFields.map((field) => (
            <option key={field} value={field}>
              {field === "is_direct"
                ? "Private chat"
                : field === "chat"
                  ? "Chat ID"
                  : fields[field]}
            </option>
          ))}
        </select>
        <select
          aria-label="Condition comparison"
          className={control}
          value={`${excluded ? "not:" : ""}${clause.op}`}
          onChange={(event) => {
            const op = event.target.value.replace("not:", "") as Clause["op"];
            const isNot = event.target.value.startsWith("not:");
            const value = listOperators.has(op)
              ? Array.isArray(clause.value)
                ? clause.value
                : [String(clause.value)]
              : Array.isArray(clause.value)
                ? clause.value.join(", ")
                : clause.value;
            const next: Node = { ...base, clause: { ...clause, op, value } };
            onChange(isNot ? { id: node.id, type: "not", child: next } : { ...next, id: node.id });
          }}
        >
          {ChannelOperators.filter((op) => !boolean || op === "is" || op === clause.op).flatMap(
            (op) => [
              <option key={op} value={op}>
                {operators[op]}
              </option>,
              <option key={`not:${op}`} value={`not:${op}`}>
                {negative[op]}
              </option>,
            ],
          )}
        </select>
        <div className="col-span-2 flex min-w-0 items-start gap-1 sm:contents">
          <div className="min-w-0 flex-1">
            {(boolean || clause.field === "kind") && clause.op === "is" ? (
              <select
                aria-label="Condition value"
                className={control}
                value={stringValue}
                onChange={(event) =>
                  updateClause({
                    ...clause,
                    value: boolean ? event.target.value === "true" : event.target.value,
                  })
                }
              >
                {!choices.includes(stringValue) && (
                  <option value={stringValue}>{stringValue || "Empty"}</option>
                )}
                {choices.map((choice) => (
                  <option key={choice} value={choice}>
                    {boolean
                      ? choice === "true"
                        ? "Yes"
                        : "No"
                      : choice === "message"
                        ? "Message"
                        : "Button action"}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                aria-label="Condition value"
                value={stringValue}
                placeholder={
                  listOperators.has(clause.op)
                    ? "Separate values with commas"
                    : clause.field === "command"
                      ? "Command name without /"
                      : "Value"
                }
                onChange={(event) =>
                  updateClause({
                    ...clause,
                    value: listOperators.has(clause.op)
                      ? event.target.value.split(",").map((value) => value.trim())
                      : event.target.value,
                  })
                }
              />
            )}
          </div>
          <div className="flex shrink-0 gap-1">
            {actions}
            {rootAdd}
          </div>
        </div>
      </div>
    </div>
  );
}

function TimeRow({
  node,
  excluded,
  actions,
  onChange,
}: {
  node: Extract<Node, { type: "time" }>;
  excluded: boolean;
  actions: React.ReactNode;
  onChange: (node: Node, excluded: boolean) => void;
}) {
  const window = node.window;
  const update = (next: Partial<ChannelTimeWindow>) =>
    onChange({ ...node, window: { ...window, ...next } }, excluded);
  const days = window.days ?? [];
  return (
    <div className="space-y-2" data-testid="channel-condition-time">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] items-start gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)_auto]">
        <select
          aria-label="Condition field"
          className={control}
          value="time"
          onChange={(event) => {
            const field = event.target.value as Clause["field"];
            onChange(
              {
                id: node.id,
                type: "condition",
                clause: {
                  field,
                  op: "is",
                  value: booleanFields.has(field) ? true : field === "kind" ? "message" : "",
                },
              },
              excluded,
            );
          }}
        >
          <option value="time">Time of day</option>
          {ChannelFields.map((field) => (
            <option key={field} value={field}>
              {fields[field]}
            </option>
          ))}
        </select>
        <select
          aria-label="Condition comparison"
          className={control}
          value={excluded ? "outside" : "within"}
          onChange={(event) => onChange(node, event.target.value === "outside")}
        >
          <option value="within">is within</option>
          <option value="outside">is outside</option>
        </select>
        <div className="col-span-2 flex min-w-0 items-center gap-1 sm:contents">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <Input
              type="time"
              aria-label="From"
              value={window.from}
              onChange={(event) => update({ from: event.target.value })}
            />
            <span className="text-sm text-muted-foreground">–</span>
            <Input
              type="time"
              aria-label="To"
              value={window.to}
              onChange={(event) => update({ to: event.target.value })}
            />
          </div>
          <div className="flex shrink-0 gap-1">{actions}</div>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {weekdays.map((label, day) => (
          <Button
            key={label}
            type="button"
            size="sm"
            variant={days.includes(day) ? "default" : "outline"}
            aria-pressed={days.includes(day)}
            onClick={() => {
              const next = days.includes(day)
                ? days.filter((d) => d !== day)
                : [...days, day].sort();
              update({ days: next.length ? next : undefined });
            }}
          >
            {label}
          </Button>
        ))}
        <Input
          aria-label="Time zone"
          className="min-w-40 flex-1"
          list="channel-time-zones"
          value={window.tz ?? ""}
          placeholder={localZone}
          onChange={(event) => update({ tz: event.target.value || undefined })}
        />
        <datalist id="channel-time-zones">
          {zones.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      </div>
    </div>
  );
}

export function ChannelConditionBuilder({
  value,
  onChange,
  onValidity,
}: {
  value: ChannelCondition;
  onChange: (value: ChannelCondition) => void;
  onValidity: (valid: boolean) => void;
}) {
  const [tree, setTree] = useState(() => fromCondition(value));
  const valid = validChannelCondition(toCondition(tree));
  return (
    <div className="min-w-0 space-y-2" data-testid="channel-condition-builder">
      <p className="text-sm font-medium">When</p>
      <NodeEditor
        node={tree}
        onChange={(next) => {
          const condition = toCondition(next);
          setTree(next);
          onChange(condition);
          onValidity(validChannelCondition(condition));
        }}
      />
      {!valid && (
        <p role="alert" className="text-sm text-error">
          Complete the condition values. Groups support up to 5 levels and 100 conditions.
        </p>
      )}
    </div>
  );
}
