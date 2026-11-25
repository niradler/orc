import { useId } from "react";
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
  /**
   * List only the backends that can enforce a session tool whitelist, and drop the "Default"
   * entry when the configured default cannot. A KB digest always runs with a whitelist, so
   * anything else is a choice the server has to refuse.
   */
  requireToolAllowlist?: boolean;
}

/**
 * Picks the agent backend a task runs on. This was a free-text field, which
 * meant the only way to learn what was installed was to type a guess and watch
 * the task fail. The list is probed server-side, so it also says which backends
 * are usable *right now* and what a missing one needs.
 */
export function BackendPicker({
  value,
  onChange,
  testId,
  requireToolAllowlist,
}: BackendPickerProps) {
  const id = useId();
  const { data, isLoading } = useBackends();
  const all = data?.backends ?? [];
  const defaultBackend = data?.default_backend;
  // A stored backend that cannot enforce the whitelist stays listed: hiding it would show an
  // empty picker for a digest saved before the rule existed, with no way to see what to fix.
  const backends = requireToolAllowlist
    ? all.filter((backend) => backend.tool_allowlist || backend.name === value)
    : all;
  const defaultUsable =
    !requireToolAllowlist ||
    all.some((backend) => backend.name === defaultBackend && backend.tool_allowlist);
  const selected = backends.find((b) => b.name === value);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="font-label text-xs text-outline">
        Agent Backend
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          id={id}
          data-testid={testId ?? "backend-picker"}
          className="bg-background border-control-border text-on-surface font-label text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="bg-surface-highest border-surface-highest max-h-72">
          {defaultUsable && (
            <SelectItem value={USE_DEFAULT_BACKEND} className="font-label text-xs">
              {defaultBackend ? `Default (${defaultBackend})` : "Default"}
            </SelectItem>
          )}
          {backends.map((backend) => (
            <SelectItem
              key={backend.name}
              value={backend.name}
              className="font-label text-xs"
              data-backend-available={backend.available}
              data-backend-tool-allowlist={backend.tool_allowlist}
            >
              {backend.name}
              <span className={backend.available ? "text-secondary" : "text-error"}>
                {backend.available ? " ● ready" : " ○ unavailable"}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="font-body text-xs text-outline" data-testid="backend-picker-hint">
        {isLoading ? "" : hint(value, selected, defaultBackend, all, requireToolAllowlist)}
      </p>
    </div>
  );
}

type Backend = {
  name: string;
  available: boolean;
  requires: string;
  error: string | null;
  tool_allowlist: boolean;
};

/**
 * The backend a digest should start on: the configured default when it can enforce the digest's
 * tool whitelist, otherwise the first capable backend that is usable right now. Preferring a
 * usable one matters twice: it is the choice that actually runs, and a backend that fails its
 * preflight can be rerouted to one that cannot enforce the whitelist.
 */
export function suggestDigestBackend(
  data: { backends: Backend[]; default_backend: string } | undefined,
): string {
  const capable = (data?.backends ?? []).filter((backend) => backend.tool_allowlist);
  // Nothing capable is installed: leave the default and let the save explain itself.
  if (!capable.length) return USE_DEFAULT_BACKEND;
  if (data && capable.some((backend) => backend.name === data.default_backend))
    return USE_DEFAULT_BACKEND;
  return (capable.find((backend) => backend.available) ?? capable[0]).name;
}

function hint(
  value: string,
  selected: Backend | undefined,
  defaultBackend: string | undefined,
  backends: Backend[],
  requireToolAllowlist?: boolean,
): string {
  const capable = backends.filter((backend) => backend.tool_allowlist);
  const choose = capable.map((backend) => backend.name).join(" or ");
  if (value === USE_DEFAULT_BACKEND) {
    const fallback = backends.find((b) => b.name === defaultBackend);
    if (requireToolAllowlist && fallback && !fallback.tool_allowlist) {
      return `The default backend "${defaultBackend}" cannot enforce a digest's tool whitelist${
        choose ? `; choose ${choose}` : ""
      }.`;
    }
    if (fallback && !fallback.available) {
      return `The default backend "${defaultBackend}" is not usable: ${fallback.error ?? fallback.requires}`;
    }
    return defaultBackend ? `Runs on ${defaultBackend}.` : "Runs on the configured default.";
  }
  if (!selected) {
    // A digest cannot run on a name that is not a registered backend: it reaches its agent
    // through acpx, which ignores the digest's tool whitelist.
    if (requireToolAllowlist)
      return `"${value}" cannot enforce a digest's tool whitelist${
        choose ? `; choose ${choose}` : ""
      }.`;
    // Any other name is passed to acpx as its agent identifier - that is how
    // gemini, codex and friends are reached, so it is not an error.
    return `"${value}" is not a registered backend; it will be passed to acpx as an agent name.`;
  }
  if (requireToolAllowlist && !selected.tool_allowlist) {
    return `"${value}" cannot enforce a digest's tool whitelist${
      choose ? `; choose ${choose}` : ""
    }.`;
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
