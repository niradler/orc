import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { createOrcClient } from "@orc/sdk";
import { useCallback, useMemo, useRef, useState } from "react";
import { ChatModal } from "./components/chat-modal.js";
import { CommandPalette } from "./components/command-palette.js";
import { StatusBar } from "./components/status-bar.js";
import { useChat } from "./hooks/use-chat.js";
import { useCommand } from "./hooks/use-command.js";
import { usePolling } from "./hooks/use-polling.js";
import { canHandleCommandInput, canSwitchRoutes } from "./navigation.js";
import { colors } from "./theme.js";
import type { Command, KeyEvent, Route, ViewKeyHandler, ViewState } from "./types.js";
import { ROUTES } from "./types.js";
import { JobsView } from "./views/jobs.js";
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
      parts.push(vs.contextData);
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

  const commands: Command[] = useMemo(
    () => [
      {
        name: "tasks",
        aliases: ["t", "task"],
        description: "View tasks",
        action: () => setRoute("tasks"),
      },
      {
        name: "jobs",
        aliases: ["j", "job"],
        description: "View jobs",
        action: () => setRoute("jobs"),
      },
      {
        name: "memories",
        aliases: ["m", "mem", "memory"],
        description: "View memories",
        action: () => setRoute("memories"),
      },
      {
        name: "projects",
        aliases: ["p", "proj", "project"],
        description: "View projects",
        action: () => setRoute("projects"),
      },
      {
        name: "sessions",
        aliases: ["s", "sess", "session"],
        description: "View sessions",
        action: () => setRoute("sessions"),
      },
      {
        name: "skills",
        aliases: ["sk", "skill"],
        description: "View skills",
        action: () => setRoute("skills"),
      },
      {
        name: "chat",
        aliases: ["c"],
        description: "Open chat",
        action: () => setChatOpen(true),
      },
      { name: "all", aliases: ["a"], description: "Clear project filter", action: clearProject },
      {
        name: "quit",
        aliases: ["q", "exit"],
        description: "Exit TUI",
        action: () => renderer.destroy(),
      },
    ],
    [clearProject, renderer],
  );

  const { active: cmdActive, input: cmdInput, handleKey: cmdHandleKey } = useCommand(commands);

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

    if (canHandleCommandInput(cmdActive, viewState.navigationLocked) && cmdHandleKey(k)) return;

    if (viewKeyHandlerRef.current(k)) return;

    if (k.name === "c" && k.ctrl) {
      renderer.destroy();
      return;
    }

    if (!canSwitchRoutes(cmdActive, viewState.navigationLocked)) return;

    if (k.name === "c") {
      setChatOpen(true);
      return;
    }

    if (k.name === "1") setRoute("projects");
    if (k.name === "2") setRoute("tasks");
    if (k.name === "3") setRoute("jobs");
    if (k.name === "4") setRoute("memories");
    if (k.name === "5") setRoute("sessions");
    if (k.name === "6") setRoute("skills");
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
          />
        )}
        {route === "tasks" && (
          <TasksView
            projectId={activeProjectId}
            onRegisterKeyHandler={registerViewKeyHandler}
            onStateChange={onViewStateChange}
          />
        )}
        {route === "jobs" && (
          <JobsView
            projectId={activeProjectId}
            onRegisterKeyHandler={registerViewKeyHandler}
            onStateChange={onViewStateChange}
          />
        )}
        {route === "memories" && (
          <MemoriesView
            projectId={activeProjectId}
            onRegisterKeyHandler={registerViewKeyHandler}
            onStateChange={onViewStateChange}
          />
        )}
        {route === "sessions" && (
          <SessionsView
            onRegisterKeyHandler={registerViewKeyHandler}
            onStateChange={onViewStateChange}
          />
        )}
        {route === "skills" && (
          <SkillsView
            onRegisterKeyHandler={registerViewKeyHandler}
            onStateChange={onViewStateChange}
          />
        )}
      </box>

      <StatusBar route={route} state={viewState} connected={connected} project={activeProject} />

      <CommandPalette active={cmdActive} input={cmdInput} commands={commands} />

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
