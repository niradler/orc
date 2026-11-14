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
import { CHAT_THREAD_PARAM, ChatProvider } from "@/hooks/useChat";
import { BREAKPOINTS, useBreakpoint } from "@/hooks/useMediaQuery";
import { useNotificationShade } from "@/hooks/useNotificationShade";
import { useProjects } from "@/hooks/useProjects";
import { sessionHomeExitSteps, useSessionHomeEntry } from "@/hooks/useSessionHome";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import { SelectedProjectProvider } from "@/lib/selected-project";
import { clearSessionHome } from "@/lib/session-home";
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

const Sessions = lazy(() => import("@/views/Sessions"));
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
  const { pathname, hash } = useLocation();
  const projectId = searchParams.get("project") ?? savedProjectId;
  const chatFullscreen = pathname === "/chat" || searchParams.get("chat") === "full";
  const chatRequested = searchParams.get("chat") === "open";
  useSessionHomeEntry(chatFullscreen);
  function setChatVisible(open: boolean): void {
    const current = new URLSearchParams(window.location.search);
    const next = open ? current : clearSessionHome(current);
    if (open) next.set("chat", "open");
    else {
      next.delete("chat");
      next.delete(CHAT_THREAD_PARAM);
    }
    if (next.toString() === new URLSearchParams(window.location.search).toString()) return;
    navigate({ search: next.toString(), hash: window.location.hash });
  }
  function chatPageSearch(): string {
    const current = new URLSearchParams(window.location.search);
    const next = new URLSearchParams();
    const project = current.get("project") ?? projectId;
    if (project) next.set("project", project);
    const thread = current.get(CHAT_THREAD_PARAM);
    if (thread) next.set(CHAT_THREAD_PARAM, thread);
    return next.toString();
  }
  function openChatPage(): void {
    if (chatFullscreen) return;
    navigate({ pathname: "/chat", search: chatPageSearch(), hash: window.location.hash });
  }
  function openChat(): void {
    if (chatFullscreen) return;
    if (desktopViewport) setChatVisible(!chatRequested);
    else openChatPage();
  }
  function minimizeChat(): void {
    // Only a redirect that replaced its source records it; a pushed chat page closes through history.
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

  // Default to collapsed rail on tablet (<lg), expanded on desktop (≥lg).
  // This is a one-shot initialization - after mount the user owns the toggle.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth < BREAKPOINTS.lg;
  });

  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [desktopViewport, setDesktopViewport] = useState(
    () => window.matchMedia(`(min-width: ${BREAKPOINTS.xl}px)`).matches,
  );
  const homeOpen = chatFullscreen;
  const chatOpen = chatRequested && desktopViewport;
  // Chat needs the width: collapse the workspace navigation while a conversation
  // is open and restore the user's own width after leaving it.
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

  // The side chat only exists on wide screens. Narrower screens use the Chat page.
  useEffect(() => {
    const desktop = window.matchMedia(`(min-width: ${BREAKPOINTS.xl}px)`);
    const navDesktop = window.matchMedia(`(min-width: ${BREAKPOINTS.md}px)`);
    const syncResponsiveChat = () => {
      if (navDesktop.matches) setMobileNavOpen(false);
      setDesktopViewport(desktop.matches);
    };
    syncResponsiveChat();
    desktop.addEventListener("change", syncResponsiveChat);
    navDesktop.addEventListener("change", syncResponsiveChat);
    return () => {
      desktop.removeEventListener("change", syncResponsiveChat);
      navDesktop.removeEventListener("change", syncResponsiveChat);
    };
  }, []);

  // `/chat` is the phone presentation; the legacy `chat=full` links point there too.
  useEffect(() => {
    // Read the live URL: closing the chat and crossing the breakpoint can land in one render.
    const live = new URLSearchParams(window.location.search);
    const legacy = live.get("chat") === "full";
    const narrow = live.get("chat") === "open" && !desktopViewport;
    if (!legacy && !narrow) return;
    const next = new URLSearchParams(live);
    next.delete("chat");
    // `searchParams` re-runs this when a chat link arrives; the live URL decides what to do.
    if (pathname === "/chat" && next.toString() === searchParams.toString()) return;
    const source = clearSessionHome(new URLSearchParams(window.location.search));
    source.delete("chat");
    source.delete(CHAT_THREAD_PARAM);
    const query = source.toString();
    navigate(
      { pathname: "/chat", search: next.toString(), hash },
      {
        replace: true,
        state: { chatSource: `${window.location.pathname}${query ? `?${query}` : ""}` },
      },
    );
  }, [searchParams, navigate, pathname, hash, desktopViewport]);

  // Workspaces whose columns own their scroll fill the main area without page padding.
  const fullBleed =
    pathname === "/terminals" ||
    pathname.startsWith("/terminals/") ||
    pathname.startsWith("/knowledge/base") ||
    pathname === "/notifications";

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
        <ChatProvider>
          <AgentNotifications>
            <DesktopPreviewWorkspace>
              <div
                data-testid="app-viewport"
                className="app-viewport bg-background flex flex-col overflow-hidden"
              >
                <div className="flex-1 min-h-0 flex">
                  {/* Sidebar: visible on md+. On mobile we instead render a Dialog drawer below. */}
                  <div className="hidden md:flex">
                    <Sidebar
                      projectId={projectId}
                      onProjectChange={setProjectId}
                      collapsed={sidebarCollapsed}
                      onToggle={toggleSidebar}
                    />
                  </div>

                  {/* Main content - the only element that owns vertical scroll for page content. */}
                  <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                    {/* The phone notifications page owns its top bar; keep the global header on desktop. */}
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
                      />
                    </div>
                    {homeOpen ? (
                      <div
                        data-testid="session-home"
                        className="chat-page flex min-h-0 min-w-0 flex-1"
                      >
                        <ChatPanel
                          open
                          embedded
                          fullscreen
                          onToggle={minimizeChat}
                          onClose={minimizeChat}
                        />
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
                              <Route
                                path="/activity"
                                element={<Dashboard projectId={projectId} />}
                              />
                              <Route path="/notifications" element={<Notifications />} />
                              <Route path="/tasks" element={<Tasks projectId={projectId} />} />
                              <Route
                                path="/tasks/:taskId"
                                element={<Tasks projectId={projectId} />}
                              />
                              <Route path="/terminals" element={<Terminals />} />
                              <Route path="/terminals/:terminalId" element={<Terminals />} />
                              <Route path="/jobs" element={<Jobs projectId={projectId} />} />
                              <Route path="/jobs/:jobId" element={<Jobs projectId={projectId} />} />
                              <Route
                                path="/webhooks"
                                element={<Webhooks projectId={projectId} />}
                              />
                              <Route
                                path="/sessions"
                                element={<Sessions projectId={projectId} />}
                              />
                              <Route path="/audit" element={<Audit projectId={projectId} />} />
                              <Route
                                path="/audit/:sessionId"
                                element={<Audit projectId={projectId} />}
                              />
                              <Route path="/projects" element={<Projects />} />
                              <Route path="/projects/:projectId" element={<Projects />} />
                              <Route path="/knowledge" element={<KnowledgeRedirect />} />
                              <Route
                                path="/knowledge/base"
                                element={<Knowledge projectId={projectId} />}
                              />
                              <Route
                                path="/knowledge/memories"
                                element={<Knowledge projectId={projectId} />}
                              />
                              <Route
                                path="/knowledge/memories/:memoryProject/:memoryName"
                                element={<Knowledge projectId={projectId} />}
                              />
                              <Route path="/skills" element={<Skills projectId={projectId} />} />
                              <Route
                                path="/skills/:skillName"
                                element={<Skills projectId={projectId} />}
                              />
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
                                path="/scratchpad"
                                element={<Scratchpads projectId={projectId} />}
                              />
                              <Route
                                path="/scratchpad/:scratchpadId"
                                element={<Scratchpads projectId={projectId} />}
                              />
                              <Route path="*" element={<Navigate to="/activity" replace />} />
                            </Routes>
                          </Suspense>
                        </div>
                      </main>
                    )}
                  </div>

                  <div className={cn("hidden xl:flex", !chatOpen && "xl:hidden")}>
                    <ChatPanel
                      open={chatOpen}
                      onToggle={() => setChatVisible(false)}
                      onToggleFullscreen={openChatPage}
                    />
                  </div>
                </div>

                {/* Mobile nav drawer (Radix Dialog, slides in from the left). */}
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
            </DesktopPreviewWorkspace>
          </AgentNotifications>
        </ChatProvider>
      </TerminalsProvider>
    </SelectedProjectProvider>
  );
}
