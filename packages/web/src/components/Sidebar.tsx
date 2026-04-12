import {
  Activity,
  BookOpen,
  Brain,
  Folder,
  History,
  Settings,
  TerminalSquare,
  CheckSquare,
  Zap,
  ChevronsUpDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useHealth } from "@/hooks/useHealth";
import { useProjects } from "@/hooks/useProjects";
import type { View } from "@/App";

const NAV_ITEMS: { id: View; label: string; icon: React.ElementType }[] = [
  { id: "dashboard", label: "Dashboard", icon: Activity },
  { id: "tasks", label: "Tasks", icon: CheckSquare },
  { id: "jobs", label: "Jobs", icon: TerminalSquare },
  { id: "memories", label: "Memories", icon: Brain },
  { id: "projects", label: "Projects", icon: Folder },
  { id: "sessions", label: "Sessions", icon: History },
  { id: "knowledge", label: "Knowledge", icon: BookOpen },
  { id: "skills", label: "Skills", icon: Zap },
];

interface SidebarProps {
  active: View;
  onNavigate: (view: View) => void;
  projectId: string;
  onProjectChange: (id: string) => void;
}

export function Sidebar({ active, onNavigate, projectId, onProjectChange }: SidebarProps) {
  const { data: health, isError } = useHealth();
  const { data: projects } = useProjects();

  const selectedLabel =
    projectId === "all"
      ? "All Projects"
      : projectId === "unassigned"
        ? "Unassigned"
        : projects?.find((p) => p.id === projectId)?.name ?? "...";

  return (
    <aside className="flex flex-col h-full w-64 fixed left-0 top-0 bg-background border-r border-surface-highest z-50 py-6">
      {/* Brand */}
      <div className="px-6 mb-4">
        <div className="font-headline font-black text-xl tracking-wider text-primary terminal-glow">
          ◈ ORC
        </div>
        <div className="font-label text-[10px] tracking-widest text-outline uppercase mt-1">
          Agent Orchestration
        </div>
      </div>

      {/* Project Selector */}
      <div className="px-3 mb-6">
        <label className="font-label text-[9px] uppercase tracking-widest text-outline px-3 mb-1 block">
          Scope
        </label>
        <div className="relative">
          <select
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

      {/* Navigation */}
      <nav className="flex-1 px-3 space-y-0.5">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2 font-label text-xs tracking-tight uppercase transition-all duration-150",
              active === id
                ? "bg-surface-highest text-primary font-bold border-r-2 border-primary translate-x-0.5"
                : "text-outline hover:text-on-surface-variant hover:bg-surface-highest/50",
            )}
          >
            <Icon size={16} strokeWidth={active === id ? 2.5 : 1.5} />
            {label}
          </button>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-3 mt-auto space-y-3">
        <div className="pt-4 border-t border-surface-highest">
          <button
            onClick={() => onNavigate("settings")}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2 font-label text-xs tracking-tight uppercase transition-all",
              active === "settings"
                ? "text-primary font-bold"
                : "text-outline hover:text-on-surface-variant",
            )}
          >
            <Settings size={16} />
            Settings
          </button>
        </div>
        <div className="px-3 py-2 flex items-center gap-2">
          <span
            className={cn(
              "w-2 h-2 rounded-full",
              isError ? "bg-error" : "bg-secondary animate-pulse",
            )}
          />
          <span className="font-label text-[9px] text-outline uppercase tracking-widest">
            {isError ? "OFFLINE" : health ? `v${health.version}` : "CONNECTING..."}
          </span>
        </div>
      </div>
    </aside>
  );
}
