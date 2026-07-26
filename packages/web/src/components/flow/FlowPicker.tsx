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
 * gets - which is otherwise invisible to anyone reading the task.
 */
export function FlowPicker({ value, onChange, testId, disabled }: FlowPickerProps) {
  const { data, isLoading } = useFlows();
  const flows = data?.flows ?? [];
  const defaultFlow = data?.default_flow;

  return (
    <div className="space-y-1.5">
      <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Flow</Label>
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
      <p className="font-body text-[10px] text-outline" data-testid="flow-picker-hint">
        {/* Nothing until the list is in: "not in the flow list" would be a lie
            about a flow we simply have not fetched yet. */}
        {isLoading ? "" : flowHint(value, flows, defaultFlow)}
      </p>
    </div>
  );
}

function flowHint(
  value: string,
  flows: Array<{ name: string; description: string; source: string; shadows: string | null }>,
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
