import { Menu, MessageSquare } from "lucide-react";
import { type Ref, useEffect, useRef } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { AgentNotificationBell } from "@/components/AgentNotifications";
import { CommandPalette } from "@/components/CommandPalette";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { Button, buttonVariants } from "@/components/ui/button";
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
  chatPage = false,
}: {
  projectId: string;
  onOpenNav: () => void;
  onOpenChat: () => void;
  onProjectChange: (id: string) => void;
  onShowChat: () => void;
  navButtonRef?: Ref<HTMLButtonElement>;
  chatButtonRef?: Ref<HTMLButtonElement>;
  chatPage?: boolean;
}) {
  const { pathname, search } = useLocation();
  const sectionNav = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!workspaceSection(pathname)) return;
    const nav = sectionNav.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (nav && active) {
      nav.scrollLeft +=
        active.getBoundingClientRect().left -
        nav.getBoundingClientRect().left -
        (nav.clientWidth - active.offsetWidth) / 2;
    }
  }, [pathname]);
  const { data: projects } = useProjects({ status: "active" });
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
      <header className="flex min-h-12 items-center gap-2 px-3 md:px-6">
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
        <AgentNotificationBell />
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
        {!chatPage && (
          <Button
            ref={chatButtonRef}
            data-testid="chat-open-button"
            variant="ghost"
            size="sm"
            onClick={onOpenChat}
          >
            <MessageSquare />
            <span className="hidden sm:inline">Chat</span>
            <span className="sr-only sm:hidden">Open chat</span>
          </Button>
        )}
      </header>
      {section && section.pages.length > 1 && (
        <nav
          ref={sectionNav}
          aria-label={`${section.label} pages`}
          className="flex gap-1 overflow-x-auto px-3 pb-1 md:px-6"
        >
          {section.pages.map((page) => (
            <NavLink
              key={page.id}
              to={workspaceDestination(page.path, projectId, search)}
              end={page.path === "/packages"}
              data-testid={page.id === "knowledge" ? "section-knowledge" : `nav-${page.id}`}
              className={({ isActive }) =>
                `flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] transition-colors lg:min-h-8 ${isActive ? "bg-surface-highest text-on-surface" : "text-outline hover:bg-surface hover:text-on-surface"}`
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
