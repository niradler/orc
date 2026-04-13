import {
  Activity,
  BookOpen,
  Brain,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Folder,
  History,
  Settings,
  TerminalSquare,
  Zap,
} from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useHealth } from "@/hooks/useHealth";
import { useProjects } from "@/hooks/useProjects";
import { cn } from "@/lib/utils";

const NAV_ITEMS: {
  id: string;
  path: string;
  label: string;
  icon: React.ElementType;
}[] = [
  { id: "dashboard", path: "/dashboard", label: "Dashboard", icon: Activity },
  { id: "tasks", path: "/tasks", label: "Tasks", icon: CheckSquare },
  { id: "jobs", path: "/jobs", label: "Jobs", icon: TerminalSquare },
  { id: "memories", path: "/memories", label: "Memories", icon: Brain },
  { id: "projects", path: "/projects", label: "Projects", icon: Folder },
  { id: "sessions", path: "/sessions", label: "Sessions", icon: History },
  { id: "knowledge", path: "/knowledge", label: "Knowledge", icon: BookOpen },
  { id: "skills", path: "/skills", label: "Skills", icon: Zap },
];

interface SidebarProps {
  projectId: string;
  onProjectChange: (id: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  /** When true, render without outer width/border chrome (used inside a mobile drawer). */
  embedded?: boolean;
  /** Called after a navigation action — used by the mobile drawer to auto-close. */
  onNavigate?: () => void;
}

function isPathActive(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

export function Sidebar({
  projectId,
  onProjectChange,
  collapsed,
  onToggle,
  embedded = false,
  onNavigate,
}: SidebarProps) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data: health, isError } = useHealth();
  const { data: projects } = useProjects();

  const _selectedLabel =
    projectId === "all"
      ? "All Projects"
      : projectId === "unassigned"
        ? "Unassigned"
        : (projects?.find((p) => p.id === projectId)?.name ?? "...");

  const settingsActive = isPathActive(pathname, "/settings");

  const handleNav = (path: string) => {
    navigate(path);
    onNavigate?.();
  };

  return (
    <aside
      className={cn(
        "flex flex-col min-h-0 bg-background py-6",
        embedded
          ? "h-full w-full"
          : cn(
              "h-full border-r border-surface-highest transition-[width] duration-200 shrink-0",
              collapsed ? "w-14" : "w-64",
            ),
      )}
    >
      {/* Brand */}
      <div className={cn("shrink-0 mb-4", collapsed && !embedded ? "px-3" : "px-6")}>
        <div
          className={cn(
            "font-headline font-black tracking-wider text-primary terminal-glow",
            collapsed && !embedded ? "text-base text-center" : "text-xl",
          )}
        >
          {collapsed && !embedded ? <span title="ORC">&#x25C8;</span> : "◈ ORC"}
        </div>
        {(!collapsed || embedded) && (
          <div className="font-label text-[10px] tracking-widest text-outline uppercase mt-1">
            Agent Orchestration
          </div>
        )}
      </div>

      {/* Project Selector */}
      {(!collapsed || embedded) && (
        <div className="shrink-0 px-3 mb-6">
          <label
            htmlFor="sidebar-project-select"
            className="font-label text-[9px] uppercase tracking-widest text-outline px-3 mb-1 block"
          >
            Scope
          </label>
          <div className="relative">
            <select
              id="sidebar-project-select"
              data-testid="sidebar-project-select"
              value={projectId}
              onChange={(e) => onProjectChange(e.target.value)}
              className={cn(
                "w-full appearance-none bg-surface-highest/50 border border-surface-highest",
                "text-on-surface font-label text-[11px] tracking-tight",
                "pl-3 pr-8 py-2 rounded-sm cursor-pointer",
                "hover:bg-surface-highest focus:outline-none focus:ring-1 focus:ring-primary/40",
                "transition-colors duration-150",
              )}
            >
              <option value="all">All Projects</option>
              <option value="unassigned">Unassigned</option>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <ChevronsUpDown
              size={12}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-outline pointer-events-none"
            />
          </div>
        </div>
      )}

      {/* Navigation — the only scroll region in the sidebar */}
      <nav
        className={cn(
          "flex-1 min-h-0 overflow-y-auto space-y-0.5",
          collapsed && !embedded ? "px-1" : "px-3",
        )}
      >
        {NAV_ITEMS.map(({ id, path, label, icon: Icon }) => {
          const active = isPathActive(pathname, path);
          return (
            <button
              key={id}
              type="button"
              data-testid={`nav-${id}`}
              onClick={() => handleNav(path)}
              title={collapsed && !embedded ? label : undefined}
              className={cn(
                "w-full flex items-center font-label text-xs tracking-tight uppercase transition-all duration-150",
                collapsed && !embedded ? "justify-center px-0 py-2" : "gap-3 px-3 py-2",
                active
                  ? "bg-surface-highest text-primary font-bold border-r-2 border-primary translate-x-0.5"
                  : "text-outline hover:text-on-surface-variant hover:bg-surface-highest/50",
              )}
            >
              <Icon size={16} strokeWidth={active ? 2.5 : 1.5} />
              {(!collapsed || embedded) && label}
            </button>
          );
        })}

        {/* Collapse toggle — hidden inside the mobile drawer (no rail mode there) */}
        {!embedded && (
          <button
            type="button"
            onClick={onToggle}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              "w-full flex items-center text-outline hover:text-on-surface-variant transition-colors duration-150 mt-2",
              collapsed ? "justify-center px-0 py-2" : "gap-3 px-3 py-2",
            )}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            {!collapsed && (
              <span className="font-label text-xs tracking-tight uppercase">Collapse</span>
            )}
          </button>
        )}
      </nav>

      {/* Footer — pinned below nav */}
      <div className={cn("shrink-0 mt-auto space-y-3", collapsed && !embedded ? "px-1" : "px-3")}>
        <div className="pt-4 border-t border-surface-highest">
          <button
            type="button"
            data-testid="nav-settings"
            onClick={() => handleNav("/settings")}
            title={collapsed && !embedded ? "Settings" : undefined}
            className={cn(
              "w-full flex items-center font-label text-xs tracking-tight uppercase transition-all",
              collapsed && !embedded ? "justify-center px-0 py-2" : "gap-3 px-3 py-2",
              settingsActive
                ? "text-primary font-bold"
                : "text-outline hover:text-on-surface-variant",
            )}
          >
            <Settings size={16} />
            {(!collapsed || embedded) && "Settings"}
          </button>
        </div>
        <div
          className={cn(
            "py-2 flex items-center",
            collapsed && !embedded ? "justify-center px-1" : "gap-2 px-3",
          )}
        >
          <span
            className={cn(
              "w-2 h-2 rounded-full",
              isError ? "bg-error" : "bg-secondary animate-pulse",
            )}
          />
          {(!collapsed || embedded) && (
            <span className="font-label text-[9px] text-outline uppercase tracking-widest">
              {isError ? "OFFLINE" : health ? `v${health.version}` : "CONNECTING..."}
            </span>
          )}
        </div>
      </div>
    </aside>
  );
}
