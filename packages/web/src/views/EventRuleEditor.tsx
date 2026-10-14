import { RULE_EVENT_ADAPTERS, type RuleHookBackend } from "@orc/core/rule-events";
import {
  type EventRule,
  EventRuleSchema,
  ORC_RULE_ACTIONS,
  type RuleOrcAction,
} from "@orc/core/rule-types";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useJobs } from "@/hooks/useJobs";

type Condition = {
  key: string;
  field: string;
  operator: string;
  value: string;
  valueType: "string" | "json";
  negate: boolean;
  ignoreCase: boolean;
};
const selectClass = "w-full rounded-md border border-control-border bg-background p-2 text-sm";
const agentNames: Record<RuleHookBackend, string> = {
  claude: "Claude",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  codex: "Codex",
};

export function EventRuleEditor({
  rule,
  projectId,
  pending,
  onSave,
  isEditing = Boolean(rule),
}: {
  rule?: EventRule;
  projectId: string | null;
  pending: boolean;
  isEditing?: boolean;
  onSave: (rule: EventRule) => void;
}) {
  const [id, setId] = useState(rule?.id ?? `rule-${Date.now().toString(36)}`);
  const [reason, setReason] = useState(rule?.reason ?? "");
  const [agents, setAgents] = useState<string>(
    rule?.scope.agents === "all" || !rule ? "all" : rule.scope.agents.join(","),
  );
  const [eventNames, setEventNames] = useState(rule?.scope.events ?? ["pre_tool"]);
  const [eventKeys, setEventKeys] = useState(() =>
    (rule?.scope.events ?? ["pre_tool"]).map(() => crypto.randomUUID()),
  );
  const [match, setMatch] = useState(rule?.filter.match ?? "all");
  const [conditions, setConditions] = useState<Condition[]>(
    () =>
      rule?.filter.conditions.map(({ predicate, negate }) => ({
        key: crypto.randomUUID(),
        field: predicate.field,
        operator: predicate.operator,
        value:
          "value" in predicate
            ? Array.isArray(predicate.value)
              ? JSON.stringify(predicate.value)
              : String(predicate.value)
            : "",
        negate: negate ?? false,
        valueType: "value" in predicate && typeof predicate.value !== "string" ? "json" : "string",
        ignoreCase: "ignore_case" in predicate && (predicate.ignore_case ?? false),
      })) ?? [
        {
          key: crypto.randomUUID(),
          field: "",
          operator: "contains",
          value: "",
          valueType: "string",
          negate: false,
          ignoreCase: false,
        },
      ],
  );
  const [type, setType] = useState(rule?.target.type ?? "block");
  const [content, setContent] = useState(
    rule?.target.type === "inject_context" ? rule.target.content : "",
  );
  const [jobId, setJobId] = useState(rule?.target.type === "job" ? rule.target.job_id : "");
  const [argv, setArgv] = useState(
    rule?.target.type === "script"
      ? JSON.stringify(rule.target.argv, null, 2)
      : '["bun", "C:/path/to/hook.ts"]',
  );
  const [mode, setMode] = useState(rule?.target.type === "script" ? rule.target.mode : "sync");
  const [timeout, setTimeoutValue] = useState(
    rule?.target.type === "script" ? rule.target.timeout_ms : 1000,
  );
  const [processorArgv, setProcessorArgv] = useState(
    rule?.target.type === "rewrite_command"
      ? JSON.stringify(rule.target.argv, null, 2)
      : '["rtk", "rewrite", "{command}"]',
  );
  const [processorTimeout, setProcessorTimeout] = useState(
    rule?.target.type === "rewrite_command" ? rule.target.timeout_ms : 1000,
  );
  const [rewriteCodes, setRewriteCodes] = useState(
    rule?.target.type === "rewrite_command"
      ? JSON.stringify(rule.target.rewrite_exit_codes)
      : "[0, 3]",
  );
  const [passthroughCodes, setPassthroughCodes] = useState(
    rule?.target.type === "rewrite_command"
      ? JSON.stringify(rule.target.passthrough_exit_codes)
      : "[1]",
  );
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [orcAction, setOrcAction] = useState<RuleOrcAction["action"]>(
    rule?.target.type === "orc_action" ? rule.target.action : "load_context",
  );
  const [orcTimeout, setOrcTimeout] = useState(
    rule?.target.type === "orc_action" ? rule.target.timeout_ms : 1000,
  );
  const [memoryDirectory, setMemoryDirectory] = useState(
    rule?.target.type === "orc_action" ? (rule.target.memory_directory ?? "auto") : "auto",
  );
  const [eventType, setEventType] = useState(
    rule?.target.type === "orc_action" ? (rule.target.event_type ?? "auto") : "auto",
  );
  const [error, setError] = useState("");
  const jobs = useJobs({ enabled: true });
  const selected =
    agents === "all"
      ? (Object.keys(agentNames) as RuleHookBackend[])
      : (agents.split(",") as RuleHookBackend[]);
  const catalog = [
    ...new Set(
      selected.flatMap((agent) => RULE_EVENT_ADAPTERS[agent]?.map((entry) => entry.event) ?? []),
    ),
  ];
  if (agents !== "all")
    catalog.push(
      ...selected.flatMap(
        (agent) => RULE_EVENT_ADAPTERS[agent]?.map((entry) => `native:${entry.native}`) ?? [],
      ),
    );
  const supports = (feature: "block" | "context" | "rewrite_command"): boolean =>
    eventNames.every((event) => {
      const entries = selected.flatMap((agent) =>
        RULE_EVENT_ADAPTERS[agent].filter(
          (entry) => entry.event === event || `native:${entry.native}` === event,
        ),
      );
      return entries.length > 0 && entries.every((entry) => entry[feature]);
    });
  const save = (): void => {
    try {
      const parsed = EventRuleSchema.parse({
        id,
        reason,
        kind: "event",
        enabled,
        scope: {
          agents: agents === "all" ? "all" : agents.split(","),
          events: eventNames,
        },
        filter: {
          match,
          conditions: conditions.map((condition) => ({
            negate: condition.negate,
            predicate: {
              field: condition.field,
              operator: condition.operator,
              ...(condition.operator === "exists"
                ? {}
                : {
                    value:
                      condition.operator === "in" ||
                      (condition.operator === "equals" && condition.valueType === "json")
                        ? JSON.parse(condition.value)
                        : condition.value,
                  }),
              ...(["regex", "contains", "starts_with", "ends_with"].includes(condition.operator)
                ? { ignore_case: condition.ignoreCase }
                : {}),
            },
          })),
        },
        target:
          type === "block"
            ? { type }
            : type === "inject_context"
              ? { type, content }
              : type === "job"
                ? { type, job_id: jobId }
                : type === "rewrite_command"
                  ? {
                      type,
                      argv: JSON.parse(processorArgv),
                      timeout_ms: processorTimeout,
                      rewrite_exit_codes: JSON.parse(rewriteCodes),
                      passthrough_exit_codes: JSON.parse(passthroughCodes),
                    }
                  : type === "orc_action"
                    ? {
                        type,
                        action: orcAction,
                        timeout_ms: orcTimeout,
                        ...(orcAction === "sync_agent_memory"
                          ? { memory_directory: memoryDirectory }
                          : {}),
                        ...(orcAction === "record_event" ? { event_type: eventType } : {}),
                      }
                    : { type, mode, argv: JSON.parse(argv), timeout_ms: timeout },
      });
      setError("");
      onSave(parsed);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const updateCondition = (index: number, values: Partial<Condition>): void =>
    setConditions((current) =>
      current.map((condition, position) =>
        position === index ? { ...condition, ...values } : condition,
      ),
    );
  return (
    <div data-testid="event-rule-editor" className="space-y-5 py-4">
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor="event-rule-id">Rule name</Label>
          <Input
            id="event-rule-id"
            data-testid="event-rule-id"
            value={id}
            onChange={(event) => setId(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="event-rule-reason">Message / reason</Label>
          <Input
            id="event-rule-reason"
            data-testid="event-rule-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      </div>
      <fieldset className="space-y-3">
        <legend className="font-medium mb-2">1. Scope</legend>
        <Label htmlFor="rule-agent">Coding agent</Label>
        <select
          id="rule-agent"
          data-testid="rule-agent"
          className={selectClass}
          value={agents}
          onChange={(event) => {
            setAgents(event.target.value);
            setEventNames(["pre_tool"]);
            setEventKeys([crypto.randomUUID()]);
          }}
        >
          <option value="all">All agents</option>
          {Object.entries(agentNames).map(([agent, name]) => (
            <option key={agent} value={agent}>
              {name}
            </option>
          ))}
          {agents.includes(",") && <option value={agents}>{agents}</option>}
        </select>
        <Label>Events to listen to</Label>
        {eventNames.map((name, index) => (
          <div key={eventKeys[index]} className="flex flex-wrap gap-2">
            <select
              aria-label={`Event ${index + 1}`}
              data-testid="rule-event"
              className={selectClass}
              value={name}
              onChange={(event) =>
                setEventNames((current) =>
                  current.map((entry, position) =>
                    position === index ? event.target.value : entry,
                  ),
                )
              }
            >
              {[...new Set(catalog)].map((event) => (
                <option key={event} value={event}>
                  {event.split("_").join(" ")}
                </option>
              ))}
            </select>
            {eventNames.length > 1 && (
              <Button
                variant="outline"
                onClick={() => {
                  setEventNames((current) => current.filter((_, position) => position !== index));
                  setEventKeys((current) => current.filter((_, position) => position !== index));
                }}
              >
                Remove event
              </Button>
            )}
          </div>
        ))}
        <Button
          variant="outline"
          disabled={eventNames.length >= 40}
          onClick={() => {
            setEventNames((current) => [...current, "post_tool"]);
            setEventKeys((current) => [...current, crypto.randomUUID()]);
          }}
        >
          Add event
        </Button>
        <div data-testid="rule-event-coverage" className="text-xs text-muted-foreground space-y-1">
          {selected.map((agent) => (
            <p key={agent}>
              {agentNames[agent]}:{" "}
              {eventNames
                .map(
                  (event) =>
                    RULE_EVENT_ADAPTERS[agent].find(
                      (entry) => entry.event === event || `native:${entry.native}` === event,
                    )?.native ?? `${event} unavailable`,
                )
                .join(", ")}
            </p>
          ))}
        </div>
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="font-medium mb-2">2. Filtering</legend>
        <select
          aria-label="Combine conditions"
          data-testid="rule-filter-match"
          className={selectClass}
          value={match}
          onChange={(event) => setMatch(event.target.value as "all" | "any")}
        >
          <option value="all">Match all conditions (AND)</option>
          <option value="any">Match any condition (OR)</option>
        </select>
        {conditions.map((condition, index) => (
          <div
            data-testid="rule-condition"
            key={condition.key}
            className="space-y-2 border-l border-outline-variant pl-3 py-1"
          >
            <div className="grid gap-2 md:grid-cols-3">
              <Input
                aria-label={`Field ${index + 1}`}
                data-testid="rule-filter-field"
                value={condition.field}
                placeholder="input.command or payload.prompt"
                onChange={(event) => updateCondition(index, { field: event.target.value })}
              />
              <select
                aria-label={`Operator ${index + 1}`}
                data-testid="rule-filter-operator"
                className={selectClass}
                value={condition.operator}
                onChange={(event) => updateCondition(index, { operator: event.target.value })}
              >
                {[
                  ["regex", "Regex"],
                  ["contains", "Contains"],
                  ["equals", "Equals"],
                  ["in", "In list (JSON)"],
                  ["starts_with", "Starts with"],
                  ["ends_with", "Ends with"],
                  ["exists", "Exists"],
                ].map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              {condition.operator !== "exists" && (
                <Input
                  aria-label={`Value ${index + 1}`}
                  data-testid="rule-filter-value"
                  value={condition.value}
                  onChange={(event) => updateCondition(index, { value: event.target.value })}
                />
              )}
            </div>
            <div className="flex flex-wrap items-center gap-4 text-xs">
              {condition.operator === "equals" && (
                <select
                  aria-label={`Value type ${index + 1}`}
                  data-testid="rule-filter-value-type"
                  className={selectClass}
                  value={condition.valueType}
                  onChange={(event) =>
                    updateCondition(index, {
                      valueType: event.target.value as Condition["valueType"],
                    })
                  }
                >
                  <option value="string">Text value</option>
                  <option value="json">JSON scalar (number, boolean, null)</option>
                </select>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={condition.negate}
                  onChange={(event) => updateCondition(index, { negate: event.target.checked })}
                />{" "}
                Negate (NOT)
              </label>
              {["regex", "contains", "starts_with", "ends_with"].includes(condition.operator) && (
                <label>
                  <input
                    type="checkbox"
                    checked={condition.ignoreCase}
                    onChange={(event) =>
                      updateCondition(index, {
                        ignoreCase: event.target.checked,
                      })
                    }
                  />{" "}
                  Ignore case
                </label>
              )}
              <Button
                variant="ghost"
                onClick={() =>
                  setConditions((current) => current.filter((_, position) => position !== index))
                }
              >
                Remove condition
              </Button>
            </div>
          </div>
        ))}
        <Button
          variant="outline"
          disabled={conditions.length >= 32}
          onClick={() =>
            setConditions((current) => [
              ...current,
              {
                key: crypto.randomUUID(),
                field: "tool",
                operator: "equals",
                value: "",
                valueType: "string",
                negate: false,
                ignoreCase: false,
              },
            ])
          }
        >
          Add condition
        </Button>
        <p className="text-xs text-muted-foreground">
          No conditions matches every selected event. Regex uses RE2 syntax. Filters apply equally
          to every target.
        </p>
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="font-medium mb-2" data-testid="rule-target-heading">
          3. Target
        </legend>
        <select
          aria-label="Target"
          data-testid="rule-target"
          className={selectClass}
          value={type}
          onChange={(event) => setType(event.target.value as EventRule["target"]["type"])}
        >
          <option value="block" disabled={!supports("block")}>
            Block{!supports("block") ? " (unavailable for this scope)" : ""}
          </option>
          <option value="inject_context" disabled={!supports("context")}>
            Inject context
            {!supports("context") ? " (unavailable for this scope)" : ""}
          </option>
          <option value="job">Run ORC job</option>
          <option value="script">Run custom script</option>
          <option value="orc_action">Run built-in ORC action</option>
          <option value="rewrite_command" disabled={!supports("rewrite_command")}>
            Rewrite command with a processor
            {!supports("rewrite_command") ? " (select Claude pre tool)" : ""}
          </option>
        </select>
        {type === "orc_action" && (
          <>
            <Label htmlFor="rule-orc-action">ORC action</Label>
            <select
              id="rule-orc-action"
              data-testid="rule-orc-action"
              className={selectClass}
              value={orcAction}
              onChange={(event) => setOrcAction(event.target.value as RuleOrcAction["action"])}
            >
              {ORC_RULE_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {action.split("_").join(" ")}
                </option>
              ))}
            </select>
            {orcAction === "sync_agent_memory" && (
              <>
                <Label htmlFor="rule-memory-directory">Claude memory directory</Label>
                <Input
                  id="rule-memory-directory"
                  data-testid="rule-memory-directory"
                  value={memoryDirectory}
                  onChange={(event) => setMemoryDirectory(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Use auto or the absolute local directory. Only Markdown topic files inside that
                  directory are shared. Session end catches writes without file-tool events.
                </p>
              </>
            )}
            {orcAction === "record_event" && (
              <>
                <Label htmlFor="rule-record-event-type">Recorded event type</Label>
                <select
                  id="rule-record-event-type"
                  data-testid="rule-record-event-type"
                  className={selectClass}
                  value={eventType}
                  onChange={(event) => setEventType(event.target.value as typeof eventType)}
                >
                  {[
                    "auto",
                    "file",
                    "task",
                    "rule",
                    "decision",
                    "git",
                    "env",
                    "error",
                    "plan",
                    "intent",
                    "subagent",
                  ].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </>
            )}
            <Label htmlFor="rule-orc-timeout">Action timeout (milliseconds)</Label>
            <Input
              id="rule-orc-timeout"
              data-testid="rule-orc-timeout"
              type="number"
              min={100}
              max={2000}
              value={orcTimeout}
              onChange={(event) => setOrcTimeout(Number(event.target.value))}
            />
            <p className="text-xs text-muted-foreground">
              Uses the existing ORC services and agent connection. Failures are visible in action
              history. Wiki consolidation is queued through Jobs and can incur model charges; it
              runs only when the scheduler dispatches it.
            </p>
          </>
        )}
        {type === "inject_context" && (
          <textarea
            aria-label="Context to inject"
            data-testid="rule-context"
            className={`${selectClass} min-h-24`}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
        )}
        {type === "job" && (
          <>
            <select
              aria-label="ORC job"
              data-testid="rule-job"
              className={selectClass}
              value={jobId}
              onChange={(event) => setJobId(event.target.value)}
            >
              <option value="">Select an enabled job</option>
              {jobs.data
                ?.filter(
                  (job) =>
                    (job.project_id ?? null) === projectId &&
                    !job.command.startsWith("__internal:"),
                )
                .map((job) => (
                  <option key={job.id} value={job.id}>
                    {job.name}
                  </option>
                ))}
            </select>
            {jobs.error && <p role="alert">{String(jobs.error)}</p>}
            <p className="text-xs text-muted-foreground">
              Jobs run in the background and must belong to this policy's project.
            </p>
          </>
        )}
        {type === "script" && (
          <>
            <select
              aria-label="Script mode"
              data-testid="rule-script-mode"
              className={selectClass}
              value={mode}
              onChange={(event) => setMode(event.target.value as "sync" | "background")}
            >
              <option value="sync">Synchronous — return a decision or context</option>
              <option value="background">Background — run through the job queue</option>
            </select>
            <Label htmlFor="rule-script-argv">Executable and arguments (JSON array)</Label>
            <textarea
              id="rule-script-argv"
              data-testid="rule-script-argv"
              className={`${selectClass} min-h-24 font-mono`}
              value={argv}
              onChange={(event) => setArgv(event.target.value)}
            />
            <Label htmlFor="rule-script-timeout">Timeout (milliseconds)</Label>
            <Input
              id="rule-script-timeout"
              data-testid="rule-script-timeout"
              type="number"
              min={100}
              max={mode === "sync" ? 2000 : 30000}
              value={timeout}
              onChange={(event) => setTimeoutValue(Number(event.target.value))}
            />
            <p className="text-xs text-muted-foreground">
              Event JSON is sent to stdin. Synchronous stdout:{" "}
              {`{"decision":"abstain","context":["..."]}`} or {`{"decision":"deny","reason":"..."}`}
              . Blocking/context results require event support. Background output is recorded in
              Jobs.
            </p>
          </>
        )}
        {type === "rewrite_command" && (
          <>
            <Label htmlFor="rule-processor-argv">
              Command processor (executable and arguments)
            </Label>
            <textarea
              id="rule-processor-argv"
              data-testid="rule-processor-argv"
              className={`${selectClass} min-h-24 font-mono`}
              value={processorArgv}
              onChange={(event) => setProcessorArgv(event.target.value)}
            />
            <Label htmlFor="rule-processor-timeout">Timeout (milliseconds)</Label>
            <Input
              id="rule-processor-timeout"
              data-testid="rule-processor-timeout"
              type="number"
              min={100}
              max={2000}
              value={processorTimeout}
              onChange={(event) => setProcessorTimeout(Number(event.target.value))}
            />
            <Label htmlFor="rule-processor-rewrite-codes">
              Exit codes returning a replacement (JSON array)
            </Label>
            <Input
              id="rule-processor-rewrite-codes"
              data-testid="rule-processor-rewrite-codes"
              value={rewriteCodes}
              onChange={(event) => setRewriteCodes(event.target.value)}
            />
            <Label htmlFor="rule-processor-passthrough-codes">
              Exit codes keeping the original command (JSON array)
            </Label>
            <Input
              id="rule-processor-passthrough-codes"
              data-testid="rule-processor-passthrough-codes"
              value={passthroughCodes}
              onChange={(event) => setPassthroughCodes(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Use any trusted local CLI. Event JSON goes to stdin; {"{command}"} as a complete
              argument passes the original command without shell interpolation. Stdout must contain
              the replacement command. Claude Bash executes it and returns its output, with normal
              permission checks. RTK example: rewrite codes [0, 3], passthrough [1]. Other failures
              block the call.
            </p>
          </>
        )}
      </fieldset>
      <label className="flex flex-wrap gap-2 text-sm">
        <input
          data-testid="event-rule-enabled"
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />{" "}
        Enabled
      </label>
      {error && (
        <p role="alert" data-testid="event-rule-error" className="text-xs whitespace-pre-wrap">
          {error}
        </p>
      )}
      <Button
        data-testid="event-rule-save"
        disabled={
          pending ||
          (type === "block" && !supports("block")) ||
          (type === "inject_context" && !supports("context")) ||
          (type === "rewrite_command" && !supports("rewrite_command"))
        }
        onClick={save}
      >
        {isEditing ? "Save rule changes" : "Save rule"}
      </Button>
    </div>
  );
}
