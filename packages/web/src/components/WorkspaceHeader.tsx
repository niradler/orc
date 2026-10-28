import { Bell, Menu, MessageSquare } from "lucide-react";
import type { Ref } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { CommandPalette } from "@/components/CommandPalette";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { Button, buttonVariants } from "@/components/ui/button";
import { useAttentionChatWaits } from "@/hooks/useAttentionChatWaits";
import { useAttentionSessions } from "@/hooks/useAttentionSessions";
import { useHumanRequests } from "@/hooks/useHumanRequests";
import { useProjects } from "@/hooks/useProjects";
import { persistTheme, useTheme } from "@/lib/theme";
import { workspaceDestination, workspacePage, workspaceSection } from "@/lib/workspace-navigation";

export function WorkspaceHeader({
  projectId,
  onOpenNav,
  onOpenChat,
  onProjectChange,
  onShowChat,
  navButtonRef,
  chatButtonRef,
}: {
  projectId: string;
  onOpenNav: () => void;
  onOpenChat: () => void;
  onProjectChange: (id: string) => void;
  onShowChat: () => void;
  navButtonRef?: Ref<HTMLButtonElement>;
  chatButtonRef?: Ref<HTMLButtonElement>;
}) {
  const { pathname, search } = useLocation();
  const { data: projects } = useProjects({ status: "active" });
  const { data: humanRequests } = useHumanRequests();
  const observedSessions = useAttentionSessions();
  const chatWaits = useAttentionChatWaits();
  const attentionCount =
    humanRequests?.filter(
      (request) => request.status === "pending" || request.status === "unavailable",
    ).length ?? 0;
  const totalAttention = attentionCount + observedSessions.data.length + chatWaits.data.length;
  const { theme, setTheme, error: themeError } = useTheme();
  const section = workspaceSection(pathname);
  const name =
    projectId === "all"
      ? "All projects"
      : projectId === "unassigned"
        ? "Unassigned"
        : (projects?.find((p) => p.id === projectId)?.name ?? "Project");
  return (
    <div className="workspace-header shrink-0 border-b border-border bg-background">
      {themeError && (
        <p role="alert" className="px-6 py-2 text-sm text-error">
          {themeError}
        </p>
      )}
      <header className="flex min-h-14 items-center gap-2 px-3 md:px-6">
        <Button
          data-testid="mobile-nav-open"
          ref={navButtonRef}
          aria-label="Open navigation"
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={onOpenNav}
        >
          <Menu />
        </Button>
        <div className="min-w-0 flex-1 truncate text-sm text-outline">
          <span className="text-on-surface">{name}</span>
          <span className="mx-2">/</span>
          {workspacePage(pathname)?.label ?? "Projects"}
        </div>
        <NavLink
          data-testid="attention-indicator"
          to={workspaceDestination("/attention", projectId, search)}
          aria-label={`Attention needed: ${totalAttention} requests`}
          className={buttonVariants({
            variant: totalAttention ? "outline" : "ghost",
            size: "sm",
          })}
        >
          <Bell size={16} />
          <span className="hidden sm:inline">Attention</span>
          {totalAttention > 0 && (
            <span className="rounded bg-surface-highest px-1.5 text-xs">{totalAttention}</span>
          )}
        </NavLink>
        <CommandPalette
          projectId={projectId}
          onProjectChange={onProjectChange}
          onOpenChat={onShowChat}
        />
        <AnimatedThemeToggler
          data-testid="theme-toggle"
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          theme={theme}
          onThemeChange={setTheme}
          onBeforeThemeChange={persistTheme}
          duration={180}
          className={buttonVariants({ variant: "ghost", size: "icon" })}
        />
        <Button
          ref={chatButtonRef}
          data-testid="chat-open-button"
          variant="outline"
          size="sm"
          onClick={onOpenChat}
        >
          <MessageSquare />
          <span className="hidden sm:inline">Chat</span>
          <span className="sr-only sm:hidden">Open chat</span>
        </Button>
      </header>
      {section && section.pages.length > 1 && (
        <nav
          aria-label={`${section.label} pages`}
          className="flex flex-wrap gap-1 px-3 pb-2 md:px-6"
        >
          {section.pages.map((page) => (
            <NavLink
              key={page.id}
              to={workspaceDestination(page.path, projectId, search)}
              end={page.path === "/packages"}
              data-testid={page.id === "knowledge" ? "section-knowledge" : `nav-${page.id}`}
              className={({ isActive }) =>
                `rounded-md px-3 py-2 text-sm transition-colors ${isActive ? "bg-surface-highest text-on-surface" : "text-outline hover:bg-surface hover:text-on-surface"}`
              }
            >
              {page.label}
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}
