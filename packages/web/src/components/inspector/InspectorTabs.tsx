import { Files, GitBranch, List } from "lucide-react";
import type { InspectorTab } from "@/lib/session-home";
import { cn } from "@/lib/utils";

/** One tab vocabulary for the desktop inspector and the phone inspector page.
 *  Changes combines the working-tree review and the branch's PR review. */
export const INSPECTOR_TAB_DEFS: { id: InspectorTab; label: string; Icon: typeof GitBranch }[] = [
  { id: "overview", label: "Overview", Icon: GitBranch },
  { id: "diff", label: "Changes", Icon: List },
  { id: "files", label: "Files", Icon: Files },
];

export function InspectorTabs({
  git,
  shown,
  onSelect,
  className,
}: {
  /** Git-backed tabs need a running terminal in the session's folder. */
  git: boolean;
  shown: InspectorTab;
  onSelect: (tab: InspectorTab) => void;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label="Inspector" className={cn("flex gap-1", className)}>
      {INSPECTOR_TAB_DEFS.map(({ id, label, Icon }) => {
        const disabled = id !== "overview" && !git;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            data-testid={`session-inspector-tab-${id}`}
            aria-selected={shown === id}
            disabled={disabled}
            onClick={() => onSelect(id)}
            className={cn(
              "inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium",
              shown === id
                ? "bg-surface-highest text-on-surface"
                : "text-outline hover:bg-surface hover:text-on-surface",
              disabled && "opacity-40",
            )}
          >
            <Icon size={14} aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
