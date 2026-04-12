import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { createOrcClient } from "@orc/sdk";
import { useCallback, useMemo, useRef, useState } from "react";
import { ChatModal } from "./components/chat-modal.js";
import { SmartPalette } from "./components/smart-palette.js";
import { StatusBar } from "./components/status-bar.js";
import { useChat } from "./hooks/use-chat.js";
import { usePalette } from "./hooks/use-palette.js";
import { usePolling } from "./hooks/use-polling.js";
import { colors } from "./theme.js";
import type { KeyEvent, PaletteCommand, Route, ViewKeyHandler, ViewState } from "./types.js";
import { ROUTES } from "./types.js";
import { JobsView } from "./views/jobs.js";
import { KnowledgeView } from "./views/knowledge.js";
import { MemoriesView } from "./views/memories.js";
import { ProjectsView } from "./views/projects.js";
import { SessionsView } from "./views/sessions.js";
import { SkillsView } from "./views/skills.js";
import { TasksView } from "./views/tasks.js";

const client = createOrcClient();
const EMPTY_VIEW_STATE: ViewState = {
  mode: "browse",
  title: "Tasks",
  countLabel: "",
  filterQuery: "",
  filterActive: false,
  navigationLocked: false,
  selectionLabel: null,
  detailId: null,
  statusMessage: null,
};

export function App() {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [route, setRoute] = useState<Route>("tasks");
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const chatInputRef = useRef("");

  const { data: healthData, error: healthError } = usePolling(() => client.health.check(), 10000);
  const connected = !!healthData && !healthError;

  const { data: skillsData } = usePolling(() => client.skills.list(), 60000);
  const skillNames = skillsData?.skills?.map((s) => s.name) ?? [];

  const viewStateRef = useRef<ViewState>(EMPTY_VIEW_STATE);
  const routeRef = useRef(route);
  routeRef.current = route;
  const activeProjectRef = useRef(activeProject);
  activeProjectRef.current = activeProject;

  const buildSystemPrompt = useCallback(() => {
    const vs = viewStateRef.current;
    const parts: string[] = [
      "You are the ORC chat assistant running inside the ORC terminal UI.",
      "ORC is a human+AI orchestration hub with tasks, jobs, memories, sessions, projects, and skills.",
      "",
      `Current view: ${routeRef.current}`,
    ];
    if (activeProjectRef.current) parts.push(`Active project: ${activeProjectRef.current}`);
    if (vs.selectionLabel) parts.push(`Selected: ${vs.selectionLabel}`);
    if (vs.detailId) parts.push(`Detail ID: ${vs.detailId}`);
    if (vs.countLabel) parts.push(`View info: ${vs.countLabel}`);
    if (skillNames.length > 0) {
      parts.push("");
      parts.push(`Available ORC skills (${skillNames.length}): ${skillNames.join(", ")}`);
    }
    if (vs.contextData) {
      parts.push("");
      parts.push("Currently selected object:");
      const ctx = vs.contextData;
      parts.push(ctx.length > 2000 ? `${ctx.slice(0, 2000)}\n[truncated]` : ctx);
    }
    parts.push("");
    parts.push("Help the user with questions about their ORC data, tasks, workflows, and skills.");
    parts.push("Be concise and direct. Reference the current view context when relevant.");
    return parts.join("\n");
  }, [skillNames]);

  const chat = useChat(buildSystemPrompt);

  const selectProject = useCallback(async (name: string) => {
    const result = await client.projects.getByName(name);
    if (result.data) {
      setActiveProject(result.data.name);
      setActiveProjectId(result.data.id);
    }
  }, []);

  const clearProject = useCallback(() => {
    setActiveProject(null);
    setActiveProjectId(null);
  }, []);

  const [viewCommands, setViewCommands] = useState<PaletteCommand[]>([]);
  const registerViewCommands = useCallback((cmds: PaletteCommand[]) => {
    setViewCommands(cmds);
  }, []);

  const viewSearchRef = useRef<{ setQuery: (q: string) => void; clear: () => void } | null>(null);
  const registerViewSearch = useCallback(
    (fns: { setQuery: (q: string) => void; clear: () => void }) => {
      viewSearchRef.current = fns;
    },
    [],
  );

  const paletteCommands: PaletteCommand[] = useMemo(() => {
    const navAvailable = () => !viewStateRef.current.navigationLocked;
    const staticCommands: PaletteCommand[] = [
      {
        id: "nav-tasks",
        name: "Tasks",
        category: "navigation",
        aliases: ["t", "task"],
        icon: "◉",
        shortcut: "2",
        available: navAvailable,
        execute: () => setRoute("tasks"),
      },
      {
        id: "nav-jobs",
        name: "Jobs",
        category: "navigation",
        aliases: ["j", "job"],
        icon: "◉",
        shortcut: "3",
        available: navAvailable,
        execute: () => setRoute("jobs"),
      },
      {
        id: "nav-memories",
        name: "Memories",
        category: "navigation",
        aliases: ["m", "mem", "memory"],
        icon: "◉",
        shortcut: "4",
        available: navAvailable,
        execute: () => setRoute("memories"),
      },
      {
        id: "nav-projects",
        name: "Projects",
        category: "navigation",
        aliases: ["p", "proj", "project"],
        icon: "◉",
        shortcut: "1",
        available: navAvailable,
        execute: () => setRoute("projects"),
      },
      {
        id: "nav-sessions",
        name: "Sessions",
        category: "navigation",
        aliases: ["sess", "session"],
        icon: "◉",
        shortcut: "5",
        available: navAvailable,
        execute: () => setRoute("sessions"),
      },
      {
        id: "nav-skills",
        name: "Skills",
        category: "navigation",
        aliases: ["sk", "skill"],
        icon: "◉",
        shortcut: "6",
        available: navAvailable,
        execute: () => setRoute("skills"),
      },
      {
        id: "sys-chat",
        name: "Chat",
        category: "system",
        aliases: ["c"],
        icon: "💬",
        shortcut: "c",
        available: () => true,
        execute: () => setChatOpen(true),
      },
      {
        id: "sys-all",
        name: "Clear project filter",
        category: "system",
        aliases: ["a", "all"],
        icon: "✕",
        available: () => true,
        execute: clearProject,
      },
      {
        id: "sys-refresh",
        name: "Refresh",
        category: "system",
        aliases: ["r", "reload"],
        icon: "↻",
        shortcut: "r",
        available: () => true,
        execute: () => {
          /* views handle their own refresh */
        },
      },
      {
        id: "sys-quit",
        name: "Quit",
        category: "system",
        aliases: ["q", "exit"],
        icon: "⏻",
        available: () => true,
        execute: () => renderer.destroy(),
      },
    ];
    return [...staticCommands, ...viewCommands];
  }, [clearProject, renderer, viewCommands]);

  const palette = usePalette(paletteCommands, {
    onSearchQuery: (q) => viewSearchRef.current?.setQuery(q),
    onSearchClear: () => viewSearchRef.current?.clear(),
  });

  const [viewState, setViewState] = useState<ViewState>(EMPTY_VIEW_STATE);

  const viewKeyHandlerRef = useRef<ViewKeyHandler>(() => false);
  const registerViewKeyHandler = useCallback((handler: ViewKeyHandler) => {
    viewKeyHandlerRef.current = handler;
  }, []);

  const onViewStateChange = useCallback((state: ViewState) => {
    setViewState(state);
    viewStateRef.current = state;
  }, []);

  useKeyboard((key) => {
    const k = key as unknown as KeyEvent;

    // Chat modal takes priority
    if (chatOpen) {
      if (k.name === "escape" && !chat.streaming) {
        setChatOpen(false);
        return;
      }
      if (k.name === "c" && k.ctrl) {
        if (chat.streaming) chat.cancel();
        else setChatOpen(false);
        return;
      }
      if (k.name === "l" && k.ctrl) {
        chat.clear();
        return;
      }
      return;
    }

    // Palette consumes all keys while open; also handles ":" to open
    if (palette.handleKey(k)) return;

    // View key handlers (CRUD, cursor, filter, etc.)
    if (viewKeyHandlerRef.current(k)) return;

    // Global shortcuts
    if (k.name === "c" && k.ctrl) {
      renderer.destroy();
      return;
    }

    if (viewState.navigationLocked) return;

    if (k.name === "c") {
      setChatOpen(true);
      return;
    }

    if (k.name === "1") setRoute("projects");
    if (k.name === "2") setRoute("tasks");
    if (k.name === "3") setRoute("jobs");
    if (k.name === "4") setRoute("memories");
    if (k.name === "5") setRoute("knowledge");
    if (k.name === "6") setRoute("sessions");
    if (k.name === "7") setRoute("skills");
    if (k.name === "left" || (k.name === "tab" && k.shift))
      setRoute((r) => ROUTES[(ROUTES.indexOf(r) - 1 + ROUTES.length) % ROUTES.length] ?? r);
    if (k.name === "right" || k.name === "tab")
      setRoute((r) => ROUTES[(ROUTES.indexOf(r) + 1) % ROUTES.length] ?? r);
  });

  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={colors.bg}>
      <box
        flexGrow={1}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        paddingTop={0}
        paddingBottom={0}
      >
        {route === "projects" && (
          <ProjectsView
            onSelectProject={selectProject}
            onRegisterKeyHandler={registerViewKeyHandler}
            onStateChange={onViewStateChange}
            onRegisterCommands={registerViewCommands}
            onRegisterSearch={registerViewSearch}
          />
        )}
        {route === "tasks" && (
          <TasksView
            projectId={activeProjectId}
            onSelectProject={selectProject}
            onClearProject={clearProject}
            onRegisterKeyHandler={registerViewKeyHandler}
            onStateChange={onViewStateChange}
            onRegisterCommands={registerViewCommands}
            onRegisterSearch={registerViewSearch}
          />
        )}
        {route === "jobs" && (
          <JobsView
            projectId={activeProjectId}
            onRegisterKeyHandler={registerViewKeyHandler}
            onStateChange={onViewStateChange}
            onRegisterCommands={registerViewCommands}
            onRegisterSearch={registerViewSearch}
          />
        )}
        {route === "memories" && (
          <MemoriesView
            projectId={activeProjectId}
            onRegisterKeyHandler={registerViewKeyHandler}
            onStateChange={onViewStateChange}
            onRegisterCommands={registerViewCommands}
            onRegisterSearch={registerViewSearch}
          />
        )}
        {route === "knowledge" && (
          <KnowledgeView
            projectId={activeProjectId}
            onRegisterKeyHandler={registerViewKeyHandler}
            onStateChange={onViewStateChange}
            onRegisterCommands={registerViewCommands}
            onRegisterSearch={registerViewSearch}
          />
        )}
        {route === "sessions" && (
          <SessionsView
            onRegisterKeyHandler={registerViewKeyHandler}
            onStateChange={onViewStateChange}
            onRegisterCommands={registerViewCommands}
            onRegisterSearch={registerViewSearch}
          />
        )}
        {route === "skills" && (
          <SkillsView
            onRegisterKeyHandler={registerViewKeyHandler}
            onStateChange={onViewStateChange}
            onRegisterCommands={registerViewCommands}
            onRegisterSearch={registerViewSearch}
          />
        )}
      </box>

      <StatusBar route={route} state={viewState} connected={connected} project={activeProject} />

      <SmartPalette
        open={palette.open}
        input={palette.input}
        cursor={palette.cursor}
        results={palette.results}
        mode={palette.mode}
      />

      {chatOpen && (
        <ChatModal
          messages={chat.messages}
          streaming={chat.streaming}
          streamText={chat.streamText}
          agent={chat.config.agent}
          onSend={chat.send}
          onCancel={chat.cancel}
          onClose={() => setChatOpen(false)}
          onClear={chat.clear}
          inputValue={chatInput}
          onInputChange={(v: string) => {
            chatInputRef.current = v;
            setChatInput(v);
          }}
          onSubmit={() => {
            if (!chat.streaming && chatInputRef.current.trim()) {
              void chat.send(chatInputRef.current);
              setChatInput("");
              chatInputRef.current = "";
            }
          }}
        />
      )}
    </box>
  );
}
