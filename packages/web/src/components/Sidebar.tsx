import {
  Activity,
  BookOpen,
  Brain,
  Folder,
  History,
  Settings,
  TerminalSquare,
  CheckSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useHealth } from "@/hooks/useHealth";
import type { View } from "@/App";

const NAV_ITEMS: { id: View; label: string; icon: React.ElementType }[] = [
  { id: "dashboard", label: "Dashboard", icon: Activity },
  { id: "tasks", label: "Tasks", icon: CheckSquare },
  { id: "jobs", label: "Jobs", icon: TerminalSquare },
  { id: "memories", label: "Memories", icon: Brain },
  { id: "projects", label: "Projects", icon: Folder },
  { id: "sessions", label: "Sessions", icon: History },
  { id: "knowledge", label: "Knowledge", icon: BookOpen },
];

interface SidebarProps {
  active: View;
  onNavigate: (view: View) => void;
}

export function Sidebar({ active, onNavigate }: SidebarProps) {
  const { data: health, isError } = useHealth();

  return (
    <aside className="flex flex-col h-full w-64 fixed left-0 top-0 bg-background border-r border-surface-highest z-50 py-6">
      {/* Brand */}
      <div className="px-6 mb-10">
        <div className="font-headline font-black text-xl tracking-wider text-primary terminal-glow">
          ◈ ORC
        </div>
        <div className="font-label text-[10px] tracking-widest text-outline uppercase mt-1">
          Agent Orchestration
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
