import * as Dialog from "@radix-ui/react-dialog";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { AgentNotifications } from "@/components/AgentNotifications";
import { ChatPanel } from "@/components/ChatPanel";
import { DesktopPreviewWorkspace } from "@/components/DesktopPreviewWorkspace";
import { WorkspaceHeader } from "@/components/WorkspaceHeader";
import { WorkspaceSidebar as Sidebar } from "@/components/WorkspaceSidebar";
import {
  CHAT_THREAD_PARAM,
  ChatProvider,
  ChatSurfaceProvider,
  SIDE_CHAT_THREAD_PARAM,
  useChatSurfaces,
} from "@/hooks/useChat";
import { BREAKPOINTS, useBreakpoint } from "@/hooks/useMediaQuery";
import { useNotificationShade } from "@/hooks/useNotificationShade";
import { useProjects } from "@/hooks/useProjects";
import { sessionHomeExitSteps, useSessionHomeEntry } from "@/hooks/useSessionHome";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import { DesktopPreviewContext } from "@/lib/desktop-preview-context";
import { SelectedProjectProvider } from "@/lib/selected-project";
import {
  clearSessionHome,
  SESSION_LIVE_PARAM,
  SESSION_TERMINAL_PARAM,
  SESSION_VIEW_PARAM,
} from "@/lib/session-home";
import { TerminalsProvider } from "@/lib/terminals";
import { cn } from "@/lib/utils";

const Packages = lazy(() => import("@/views/PackageCatalog"));

const Agents = lazy(() => import("@/views/Agents"));

const Dashboard = lazy(() => import("@/views/Dashboard"));

const Jobs = lazy(() => import("@/views/Jobs"));
const Webhooks = lazy(() => import("@/views/Webhooks"));

const Knowledge = lazy(() => import("@/views/Knowledge"));

const Projects = lazy(() => import("@/views/Projects"));

const Rules = lazy(() => import("@/views/Rules"));

const Scratchpads = lazy(() => import("@/views/Scratchpads"));

const Audit = lazy(() => import("@/views/Audit"));

const Settings = lazy(() => import("@/views/Settings"));
const IntegrationCallback = lazy(() => import("@/views/IntegrationCallback"));

const Skills = lazy(() => import("@/views/Skills"));

const Tasks = lazy(() => import("@/views/Tasks"));

const Notifications = lazy(() => import("@/views/Notifications"));

const Terminals = lazy(() => import("@/views/Terminals"));

function DefaultWorkspaceRedirect() {
  const { search, hash } = useLocation();
  return <Navigate replace to={{ pathname: "/activity", search, hash }} />;
}

const STORAGE_KEY = "orc_selected_project";

function KnowledgeRedirect() {
  const { search, hash } = useLocation();
  return <Navigate replace to={{ pathname: "/knowledge/base", search, hash }} />;
}

export default function App() {
  useVisualViewport();
  useNotificationShade(!useBreakpoint("md"));
  const [savedProjectId, setSavedProjectId] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? "all";
    } catch {
      return "all";
    }
  });
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const projectId = searchParams.get("project") ?? savedProjectId;
  const setProjectId = useCallback(
    (nextProjectId: string): void => {
      setSavedProjectId(nextProjectId);
      const next = new URLSearchParams(window.location.search);
      next.set("project", nextProjectId);
      if (next.toString() === new URLSearchParams(window.location.search).toString()) return;
      navigate({ search: next.toString(), hash: window.location.hash });
    },
    [navigate],
  );
  const [desktopViewport, setDesktopViewport] = useState(
    () => window.matchMedia(`(min-width: ${BREAKPOINTS.xl}px)`).matches,
  );
  useEffect(() => {
    const desktop = window.matchMedia(`(min-width: ${BREAKPOINTS.xl}px)`);
    const syncDesktop = () => setDesktopViewport(desktop.matches);
    syncDesktop();
    desktop.addEventListener("change", syncDesktop);
    return () => desktop.removeEventListener("change", syncDesktop);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, savedProjectId);
    } catch {
      /* Project scope remains usable when storage is unavailable. */
    }
  }, [savedProjectId]);

  const { data: selectableProjects } = useProjects({ status: "active" });
  useEffect(() => {
    if (!selectableProjects) return;
    if (savedProjectId === "all" || savedProjectId === "unassigned") return;
    if (selectableProjects.some((p) => p.id === savedProjectId)) return;
    setSavedProjectId("all");
  }, [selectableProjects, savedProjectId]);

  useEffect(() => {
    if (searchParams.has("project") || !selectableProjects) return;
    if (
      savedProjectId !== "all" &&
      savedProjectId !== "unassigned" &&
      !selectableProjects.some((project) => project.id === savedProjectId)
    )
      return;
    const next = new URLSearchParams(window.location.search);
    if (next.has("project")) return;
    next.set("project", savedProjectId);
    navigate(
      { pathname: window.location.pathname, search: next.toString(), hash: window.location.hash },
      { replace: true },
    );
  }, [searchParams, selectableProjects, savedProjectId, navigate]);

  return (
    <SelectedProjectProvider projectId={projectId} setProjectId={setProjectId}>
      <TerminalsProvider>
        <ChatProvider desktopViewport={desktopViewport}>
          <AgentNotifications>
            <DesktopPreviewWorkspace>
              <AppShell
                projectId={projectId}
                setProjectId={setProjectId}
                desktopViewport={desktopViewport}
              />
            </DesktopPreviewWorkspace>
          </AgentNotifications>
        </ChatProvider>
      </TerminalsProvider>
    </SelectedProjectProvider>
  );
}

function AppShell({
  projectId,
  setProjectId,
  desktopViewport,
}: {
  projectId: string;
  setProjectId: (nextProjectId: string) => void;
  desktopViewport: boolean;
}) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { pathname, hash } = useLocation();
  const { side: sideTab, handoff } = useChatSurfaces();
  const sideTabRef = useRef(sideTab);
  sideTabRef.current = sideTab;
  const chatFullscreen = pathname === "/chat" || searchParams.get("chat") === "full";
  const chatRequested = searchParams.get("chat") === "open";
  useSessionHomeEntry(chatFullscreen);
  function setChatVisible(open: boolean): void {
    const current = new URLSearchParams(window.location.search);
    const onChatPage = window.location.pathname === "/chat" || current.get("chat") === "full";
    const next = open || onChatPage ? new URLSearchParams(current) : clearSessionHome(current);
    if (open) next.set("chat", "open");
    else {
      next.delete("chat");
      next.delete(SIDE_CHAT_THREAD_PARAM);
      if (!onChatPage) next.delete(CHAT_THREAD_PARAM);
    }
    if (next.toString() === current.toString()) return;
    navigate({ search: next.toString(), hash: window.location.hash });
  }
  function openChatPage(): void {
    if (chatFullscreen) return;
    const current = new URLSearchParams(window.location.search);
    const next = new URLSearchParams();
    const project = current.get("project") ?? projectId;
    if (project) next.set("project", project);
    navigate({ pathname: "/chat", search: next.toString(), hash: window.location.hash });
  }
  function expandSideChat(): void {
    handoff("side", "page");
    const current = new URLSearchParams(window.location.search);
    const next = new URLSearchParams();
    const project = current.get("project") ?? projectId;
    if (project) next.set("project", project);
    const sideThread =
      sideTabRef.current.thread?.id ??
      (chatFullscreen ? current.get(SIDE_CHAT_THREAD_PARAM) : current.get(CHAT_THREAD_PARAM));
    if (sideThread) next.set(CHAT_THREAD_PARAM, sideThread);
    navigate({ pathname: "/chat", search: next.toString(), hash: window.location.hash });
  }
  function openChat(): void {
    if (desktopViewport) setChatVisible(!chatRequested);
    else if (!chatFullscreen) openChatPage();
  }
  function minimizeChat(): void {
    const state = window.history.state as { usr?: { chatSource?: unknown } } | null;
    const source = state?.usr?.chatSource;
    if (typeof source === "string" && source.startsWith("/") && !source.startsWith("/chat")) {
      navigate(source, { replace: true });
      return;
    }
    const steps = sessionHomeExitSteps();
    if (steps > 0) navigate(-steps);
    else {
      const search = new URLSearchParams({ project: searchParams.get("project") ?? projectId });
      navigate({ pathname: "/activity", search: search.toString() }, { replace: true });
    }
  }

  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth < BREAKPOINTS.lg;
  });

  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const homeOpen = chatFullscreen;
  const chatOpen = chatRequested && desktopViewport;
  const chatOnScreen = homeOpen || chatOpen;
  const sidebarAutoCollapsed = useRef(false);
  const chatWasOnScreen = useRef(false);
  useEffect(() => {
    const was = chatWasOnScreen.current;
    chatWasOnScreen.current = chatOnScreen;
    if (chatOnScreen === was) return;
    if (chatOnScreen && !sidebarCollapsed) {
      sidebarAutoCollapsed.current = true;
      setSidebarCollapsed(true);
    } else if (!chatOnScreen && sidebarAutoCollapsed.current) {
      sidebarAutoCollapsed.current = false;
      setSidebarCollapsed(false);
    }
  }, [chatOnScreen, sidebarCollapsed]);
  const toggleSidebar = useCallback(() => {
    sidebarAutoCollapsed.current = false;
    setSidebarCollapsed((value) => !value);
  }, []);
  const navButtonRef = useRef<HTMLButtonElement>(null);
  const chatButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const navDesktop = window.matchMedia(`(min-width: ${BREAKPOINTS.md}px)`);
    const syncNav = () => {
      if (navDesktop.matches) setMobileNavOpen(false);
    };
    syncNav();
    navDesktop.addEventListener("change", syncNav);
    return () => navDesktop.removeEventListener("change", syncNav);
  }, []);

  useEffect(() => {
    const live = new URLSearchParams(window.location.search);
    const legacy = live.get("chat") === "full";
    const narrow = live.get("chat") === "open" && !desktopViewport;
    if (!legacy && !narrow) return;
    const next = new URLSearchParams(live);
    next.delete("chat");
    next.delete(SIDE_CHAT_THREAD_PARAM);
    if (narrow) {
      handoff("side", "page");
      next.delete(SESSION_VIEW_PARAM);
      next.delete(SESSION_LIVE_PARAM);
      if (pathname === "/chat") next.delete(SESSION_TERMINAL_PARAM);
      const sideThread =
        live.get(SIDE_CHAT_THREAD_PARAM) ??
        (pathname === "/chat"
          ? (sideTabRef.current.thread?.id ?? null)
          : live.get(CHAT_THREAD_PARAM));
      if (sideThread) next.set(CHAT_THREAD_PARAM, sideThread);
      else next.delete(CHAT_THREAD_PARAM);
    }
    if (pathname === "/chat" && next.toString() === searchParams.toString()) return;
    if (pathname === "/chat") {
      navigate({ pathname: "/chat", search: next.toString(), hash }, { replace: true });
      return;
    }
    const source = clearSessionHome(new URLSearchParams(window.location.search));
    source.delete("chat");
    source.delete(CHAT_THREAD_PARAM);
    source.delete(SIDE_CHAT_THREAD_PARAM);
    const query = source.toString();
    navigate(
      { pathname: "/chat", search: next.toString(), hash },
      {
        replace: true,
        state: { chatSource: `${window.location.pathname}${query ? `?${query}` : ""}` },
      },
    );
  }, [searchParams, navigate, pathname, hash, desktopViewport, handoff]);

  const fullBleed =
    pathname === "/terminals" ||
    pathname.startsWith("/terminals/") ||
    pathname.startsWith("/knowledge/base") ||
    pathname === "/notifications";

  return (
    <div
      data-testid="app-viewport"
      className="app-viewport bg-background flex flex-col overflow-hidden"
    >
      <div className="flex-1 min-h-0 flex">
        <div className="hidden md:flex">
          <Sidebar
            projectId={projectId}
            onProjectChange={setProjectId}
            collapsed={sidebarCollapsed}
            onToggle={toggleSidebar}
            onSectionNavigate={() => {
              sidebarAutoCollapsed.current = false;
              setSidebarCollapsed(true);
            }}
          />
        </div>

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div className={cn(pathname === "/notifications" && "max-md:hidden")}>
            <WorkspaceHeader
              onShowChat={openChatPage}
              onProjectChange={setProjectId}
              navButtonRef={navButtonRef}
              chatButtonRef={chatButtonRef}
              projectId={projectId}
              onOpenNav={() => setMobileNavOpen(true)}
              onOpenChat={openChat}
              chatPage={homeOpen}
              chatOpen={chatOpen}
            />
          </div>
          {homeOpen ? (
            <div data-testid="session-home" className="chat-page flex min-h-0 min-w-0 flex-1">
              <ChatSurfaceProvider surface="page">
                <ChatPanel
                  open
                  embedded
                  fullscreen
                  onToggle={minimizeChat}
                  onClose={minimizeChat}
                />
              </ChatSurfaceProvider>
            </div>
          ) : (
            <main
              className={cn(
                "relative flex-1 min-w-0 min-h-0",
                fullBleed ? "overflow-hidden" : "overflow-y-auto",
              )}
            >
              <div
                className={cn(
                  fullBleed
                    ? "absolute inset-0 flex"
                    : "p-4 md:p-6 lg:p-8 min-h-full flex flex-col",
                )}
              >
                <Suspense
                  fallback={
                    <div role="status" className="p-6 text-sm text-outline">
                      Loading workspace…
                    </div>
                  }
                >
                  <Routes>
                    <Route path="/" element={<DefaultWorkspaceRedirect />} />
                    <Route path="/activity" element={<Dashboard projectId={projectId} />} />
                    <Route path="/notifications" element={<Notifications />} />
                    <Route path="/tasks" element={<Tasks projectId={projectId} />} />
                    <Route path="/tasks/:taskId" element={<Tasks projectId={projectId} />} />
                    <Route path="/terminals" element={<Terminals />} />
                    <Route path="/terminals/:terminalId" element={<Terminals />} />
                    <Route path="/jobs" element={<Jobs projectId={projectId} />} />
                    <Route path="/jobs/:jobId" element={<Jobs projectId={projectId} />} />
                    <Route path="/webhooks" element={<Webhooks projectId={projectId} />} />
                    <Route path="/audit" element={<Audit projectId={projectId} />} />
                    <Route path="/audit/:sessionId" element={<Audit projectId={projectId} />} />
                    <Route path="/projects" element={<Projects />} />
                    <Route path="/projects/:projectId" element={<Projects />} />
                    <Route path="/knowledge" element={<KnowledgeRedirect />} />
                    <Route path="/knowledge/base" element={<Knowledge projectId={projectId} />} />
                    <Route
                      path="/knowledge/memories"
                      element={<Knowledge projectId={projectId} />}
                    />
                    <Route
                      path="/knowledge/memories/:memoryProject/:memoryName"
                      element={<Knowledge projectId={projectId} />}
                    />
                    <Route path="/skills" element={<Skills projectId={projectId} />} />
                    <Route path="/skills/:skillName" element={<Skills projectId={projectId} />} />
                    <Route path="/packages" element={<Packages />} />
                    <Route path="/packages/item" element={<Packages />} />
                    <Route path="/packages/item/:packageName" element={<Packages />} />
                    <Route path="/packages/agents" element={<Agents />} />
                    <Route path="/packages/agents/:agentId" element={<Agents />} />
                    <Route path="/settings" element={<Settings />} />
                    <Route
                      path="/integrations/oauth/:name/callback"
                      element={<IntegrationCallback />}
                    />
                    <Route path="/rules" element={<Rules />} />
                    <Route
                      path="/knowledge/scratchpads"
                      element={<Scratchpads projectId={projectId} />}
                    />
                    <Route
                      path="/knowledge/scratchpads/:scratchpadId"
                      element={<Scratchpads projectId={projectId} />}
                    />
                    <Route path="*" element={<Navigate to="/activity" replace />} />
                  </Routes>
                </Suspense>
              </div>
            </main>
          )}
        </div>

        <div data-testid="side-chat" className={cn("hidden xl:flex", !chatOpen && "xl:hidden")}>
          <DesktopPreviewContext.Provider value={null}>
            <ChatSurfaceProvider surface="side">
              <ChatPanel
                open={chatOpen}
                onToggle={() => setChatVisible(false)}
                onToggleFullscreen={expandSideChat}
              />
            </ChatSurfaceProvider>
          </DesktopPreviewContext.Provider>
        </div>
      </div>

      <Dialog.Root open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="md:hidden fixed inset-0 z-50 bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <Dialog.Content
            data-testid="mobile-nav-drawer"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (window.innerWidth < BREAKPOINTS.md) navButtonRef.current?.focus();
              else chatButtonRef.current?.focus();
            }}
            className="viewport-sheet md:hidden fixed left-0 z-50 w-72 max-w-[85vw] bg-background border-r border-surface-highest shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left"
          >
            <Dialog.Title className="sr-only">Navigation</Dialog.Title>
            <Dialog.Description className="sr-only">
              Main navigation and project selector
            </Dialog.Description>
            <Sidebar
              projectId={projectId}
              onProjectChange={setProjectId}
              collapsed={false}
              onToggle={() => {}}
              embedded
              onNavigate={() => setMobileNavOpen(false)}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
