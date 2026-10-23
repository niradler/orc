import {
  Activity,
  BookOpen,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Package,
  Settings,
  Terminal,
} from "lucide-react";
import type { ElementType } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ProjectPicker } from "@/components/ProjectPicker";
import { Button } from "@/components/ui/button";
import { useHealth } from "@/hooks/useHealth";
import { useSsh } from "@/hooks/useSsh";
import { useTerminals } from "@/lib/terminals";
import { cn } from "@/lib/utils";
import {
  WORKSPACE_SECTIONS,
  workspaceDestination,
  workspaceSection,
} from "@/lib/workspace-navigation";

const icons: Record<string, ElementType> = {
  tasks: CheckSquare,
  knowledge: BookOpen,
  terminals: Terminal,
  activity: Activity,
  library: Package,
  settings: Settings,
};

export function WorkspaceSidebar({
  projectId,
  onProjectChange,
  collapsed,
  onToggle,
  embedded = false,
  onNavigate,
}: {
  projectId: string;
  onProjectChange: (id: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  embedded?: boolean;
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const { data: health, isError } = useHealth();
  const { data: ssh } = useSsh();
  const host = ssh ? (ssh.host ?? "local") : null;
  const connectionStatus = isError
    ? "Offline"
    : health
      ? `Connected${host ? ` (${host})` : ""}`
      : "Connecting…";
  const { terminals } = useTerminals();
  const running = terminals.filter((terminal) => terminal.status === "running").length;
  const rail = collapsed && !embedded;
  const active = workspaceSection(pathname)?.id;
  return (
    <aside
      data-testid="workspace-sidebar"
      className={cn(
        "flex h-full min-h-0 shrink-0 flex-col bg-sidebar px-2 py-3",
        embedded ? "w-full" : "border-r border-border",
        !embedded && (rail ? "w-16" : "w-48"),
      )}
    >
      <ProjectPicker
        projectId={projectId}
        onProjectChange={onProjectChange}
        compact={rail}
        shortcutEnabled={!embedded}
        onNavigate={onNavigate}
      />
      <nav aria-label="Workspace" className="mt-7 flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
        {WORKSPACE_SECTIONS.map((section) => {
          const Icon = icons[section.id];
          return (
            <button
              key={section.id}
              type="button"
              data-testid={`nav-${section.id}`}
              aria-current={active === section.id ? "page" : undefined}
              aria-label={section.label}
              title={rail ? section.label : undefined}
              onClick={() => {
                navigate(workspaceDestination(section.path, projectId, search));
                onNavigate?.();
              }}
              className={cn(
                "flex min-h-11 items-center gap-3 rounded-lg px-3 text-left text-sm transition-colors",
                section.id === "settings" && "mt-auto",
                rail && "justify-center px-0",
                active === section.id
                  ? "bg-surface-highest text-on-surface"
                  : "text-outline hover:bg-surface hover:text-on-surface",
              )}
            >
              <Icon className="size-4 shrink-0" />
              {!rail && <span className="flex-1">{section.label}</span>}
              {section.id === "terminals" && running > 0 && !rail && (
                <span className="rounded bg-surface px-1.5 text-xs text-primary">{running}</span>
              )}
            </button>
          );
        })}
      </nav>
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-border px-2 pt-3">
        {!rail && (
          <span
            className="flex min-w-0 items-center gap-2 text-xs text-outline"
            title={host ? `Execution host: ${host}` : connectionStatus}
            data-testid="workspace-connection-status"
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                isError ? "bg-error" : "bg-secondary",
              )}
            />
            <span className="truncate">{connectionStatus}</span>
          </span>
        )}
        {!embedded && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}
            className="size-8 shrink-0"
            onClick={onToggle}
          >
            {rail ? <ChevronRight /> : <ChevronLeft />}
          </Button>
        )}
      </div>
    </aside>
  );
}
