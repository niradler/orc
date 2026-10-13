import { AlertTriangle, GitBranch } from "lucide-react";
import { useState } from "react";
import { FlowDetailSheet } from "@/components/flow/FlowDetailSheet";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useFlows } from "@/hooks/useFlows";

/** Sentinel for "no flow_name" - the task runs whatever agent_loop.default_flow is. */
export const USE_DEFAULT_FLOW = "__default__";

interface FlowPickerProps {
  /** Flow name, or `USE_DEFAULT_FLOW` when the task carries none. */
  value: string;
  onChange: (value: string) => void;
  testId?: string;
  disabled?: boolean;
}

/**
 * Picks the flow graph a task will run. The list comes from GET /flows, so it
 * includes user and project flows, and marks the one a task with no flow_name
 * gets - which is otherwise invisible to anyone reading the task. "View flow"
 * opens the selected graph, and definitions that failed validation are listed
 * here so a broken user/project flow is seen where flows are chosen.
 */
export function FlowPicker({ value, onChange, testId, disabled }: FlowPickerProps) {
  const { data, isLoading } = useFlows();
  const flows = data?.flows ?? [];
  const broken = data?.broken ?? [];
  const defaultFlow = data?.default_flow;
  const [viewing, setViewing] = useState(false);
  const resolved = value === USE_DEFAULT_FLOW ? defaultFlow : value;
  const viewable = resolved !== undefined && flows.some((f) => f.name === resolved);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="font-label text-[11px] uppercase tracking-widest text-outline">
          Flow
        </Label>
        {viewable && (
          <button
            type="button"
            data-testid="flow-picker-view"
            onClick={() => setViewing(true)}
            className="inline-flex items-center gap-1 font-label text-[11px] uppercase tracking-widest text-primary hover:underline"
          >
            <GitBranch size={11} />
            View flow
          </button>
        )}
      </div>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger
          data-testid={testId ?? "flow-picker"}
          className="bg-background border-surface-highest text-on-surface font-label text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="bg-surface-highest border-surface-highest max-h-72">
          <SelectItem value={USE_DEFAULT_FLOW} className="font-label text-xs">
            {defaultFlow ? `Default (${defaultFlow})` : "Default"}
          </SelectItem>
          {flows.map((flow) => (
            <SelectItem key={flow.name} value={flow.name} className="font-label text-xs">
              {flow.name}
              <span className="text-outline"> · {flow.source}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="font-body text-[11px] text-outline" data-testid="flow-picker-hint">
        {/* Nothing until the list is in: "not in the flow list" would be a lie
            about a flow we simply have not fetched yet. */}
        {isLoading ? "" : flowHint(value, flows, defaultFlow)}
      </p>
      {broken.length > 0 && <BrokenFlows broken={broken} />}
      <FlowDetailSheet
        flowName={viewing ? (resolved ?? null) : null}
        open={viewing}
        onClose={() => setViewing(false)}
      />
    </div>
  );
}

/**
 * Definitions that failed validation. The API reports these rather than
 * skipping them silently, so a flow that will never run is visible where flows
 * are picked instead of only surfacing when a task tries to start it.
 */
function BrokenFlows({
  broken,
}: {
  broken: Array<{ name: string; path: string; errors: string[] }>;
}) {
  return (
    <details className="border border-error/40 rounded-sm bg-error/5" data-testid="broken-flows">
      <summary className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer font-label text-[11px] uppercase tracking-widest text-error">
        <AlertTriangle size={11} />
        {broken.length} invalid {broken.length === 1 ? "flow" : "flows"} not offered
      </summary>
      <div className="divide-y divide-error/10 border-t border-error/20">
        {broken.map((b) => (
          <div
            key={b.path || b.name}
            className="px-2 py-1.5 space-y-1"
            data-testid="broken-flow-row"
            data-flow-name={b.name}
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-body text-xs text-on-surface">{b.name}</span>
              <code className="font-mono text-[11px] text-outline break-all">{b.path}</code>
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
    </details>
  );
}

function flowHint(
  value: string,
  flows: Array<{
    name: string;
    description: string;
    source: string;
    shadows: string | null;
  }>,
  defaultFlow: string | undefined,
): string {
  const name = value === USE_DEFAULT_FLOW ? defaultFlow : value;
  const flow = flows.find((f) => f.name === name);
  if (!flow) {
    return value === USE_DEFAULT_FLOW
      ? "Runs the configured default flow."
      : `"${value}" is not in the flow list — the task will not start until it exists.`;
  }
  const shadow = flow.shadows ? ` (shadows the ${flow.shadows} flow of the same name)` : "";
  return `${flow.description || flow.name}${shadow}`;
}

/**
 * What a task will actually run, for display. `flow_override` beats a name, and
 * no name at all means the configured default.
 */
export function useEffectiveFlow(task: { flow_name?: string | null; flow_override?: unknown }): {
  label: string;
  name: string | null;
} {
  const { data } = useFlows();
  if (task.flow_override) return { label: "inline (task override)", name: null };
  if (task.flow_name) return { label: task.flow_name, name: task.flow_name };
  const fallback = data?.default_flow;
  return fallback
    ? { label: `${fallback} (default)`, name: fallback }
    : { label: "default", name: null };
}
