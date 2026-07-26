import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBackends } from "@/hooks/useBackends";

/** Sentinel for "no agent_backend" - the task runs agent_loop.default_backend. */
export const USE_DEFAULT_BACKEND = "__default__";

interface BackendPickerProps {
  /** Backend name, or `USE_DEFAULT_BACKEND` when the task carries none. */
  value: string;
  onChange: (value: string) => void;
  testId?: string;
}

/**
 * Picks the agent backend a task runs on. This was a free-text field, which
 * meant the only way to learn what was installed was to type a guess and watch
 * the task fail. The list is probed server-side, so it also says which backends
 * are usable *right now* and what a missing one needs.
 */
export function BackendPicker({ value, onChange, testId }: BackendPickerProps) {
  const { data, isLoading } = useBackends();
  const backends = data?.backends ?? [];
  const defaultBackend = data?.default_backend;
  const selected = backends.find((b) => b.name === value);

  return (
    <div className="space-y-1.5">
      <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
        Agent Backend
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          data-testid={testId ?? "backend-picker"}
          className="bg-background border-surface-highest text-on-surface font-label text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="bg-surface-highest border-surface-highest max-h-72">
          <SelectItem value={USE_DEFAULT_BACKEND} className="font-label text-xs">
            {defaultBackend ? `Default (${defaultBackend})` : "Default"}
          </SelectItem>
          {backends.map((backend) => (
            <SelectItem
              key={backend.name}
              value={backend.name}
              className="font-label text-xs"
              data-backend-available={backend.available}
            >
              {backend.name}
              <span className={backend.available ? "text-secondary" : "text-error"}>
                {backend.available ? " ● ready" : " ○ unavailable"}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="font-body text-[10px] text-outline" data-testid="backend-picker-hint">
        {isLoading ? "" : hint(value, selected, defaultBackend, backends)}
      </p>
    </div>
  );
}

type Backend = { name: string; available: boolean; requires: string; error: string | null };

function hint(
  value: string,
  selected: Backend | undefined,
  defaultBackend: string | undefined,
  backends: Backend[],
): string {
  if (value === USE_DEFAULT_BACKEND) {
    const fallback = backends.find((b) => b.name === defaultBackend);
    if (fallback && !fallback.available) {
      return `The default backend "${defaultBackend}" is not usable: ${fallback.error ?? fallback.requires}`;
    }
    return defaultBackend ? `Runs on ${defaultBackend}.` : "Runs on the configured default.";
  }
  if (!selected) {
    // Any other name is passed to acpx as its agent identifier - that is how
    // gemini, codex and friends are reached, so it is not an error.
    return `"${value}" is not a registered backend — it will be passed to acpx as an agent name.`;
  }
  if (!selected.available) return selected.error ?? `Needs ${selected.requires}`;
  return selected.requires || "Ready.";
}

/**
 * What a task will actually run on, for display: its own backend, or the
 * configured default named explicitly rather than left blank.
 */
export function useEffectiveBackend(task: { agent_backend?: string | null }): {
  label: string;
  available: boolean | null;
} {
  const { data } = useBackends();
  const name = task.agent_backend ?? data?.default_backend ?? null;
  const probe = data?.backends.find((b) => b.name === name);
  if (!name) return { label: "default", available: null };
  return {
    label: task.agent_backend ? name : `${name} (default)`,
    available: probe ? probe.available : null,
  };
}
