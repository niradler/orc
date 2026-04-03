import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { createOrcClient } from "@orc/sdk";
import { useCallback, useMemo, useRef, useState } from "react";
import { CommandPalette } from "./components/command-palette.js";
import { Header } from "./components/header.js";
import { StatusBar } from "./components/status-bar.js";
import { useCommand } from "./hooks/use-command.js";
import { usePolling } from "./hooks/use-polling.js";
import { canHandleCommandInput, canSwitchRoutes } from "./navigation.js";
import { colors } from "./theme.js";
import type { Command, KeyEvent, Route, ViewKeyHandler, ViewState } from "./types.js";
import { ROUTES } from "./types.js";
import { JobsView } from "./views/jobs.js";
import { MemoriesView } from "./views/memories.js";
import { ProjectsView } from "./views/projects.js";
import { PromptsView } from "./views/prompts.js";
import { SessionsView } from "./views/sessions.js";
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

const TAB_LABELS: Record<Route, string> = {
  projects: "Projects",
  tasks: "Tasks",
  jobs: "Jobs",
  memories: "Memories",
  sessions: "Sessions",
  prompts: "Prompts",
};

export function App() {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [route, setRoute] = useState<Route>("tasks");
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  const { data: healthData, error: healthError } = usePolling(() => client.health.check(), 10000);
  const connected = !!healthData && !healthError;

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
        name: "prompts",
        aliases: ["pr", "prompt"],
        description: "View prompts",
        action: () => setRoute("prompts"),
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
  }, []);

  useKeyboard((key) => {
    const k = key as unknown as KeyEvent;

    if (canHandleCommandInput(cmdActive, viewState.navigationLocked) && cmdHandleKey(k)) return;

    if (viewKeyHandlerRef.current(k)) return;

    if (k.name === "c" && k.ctrl) {
      renderer.destroy();
      return;
    }

    if (!canSwitchRoutes(cmdActive, viewState.navigationLocked)) return;

    if (k.name === "1") setRoute("projects");
    if (k.name === "2") setRoute("tasks");
    if (k.name === "3") setRoute("jobs");
    if (k.name === "4") setRoute("memories");
    if (k.name === "5") setRoute("sessions");
    if (k.name === "6") setRoute("prompts");
    if (k.name === "left")
      setRoute((r) => ROUTES[(ROUTES.indexOf(r) - 1 + ROUTES.length) % ROUTES.length] ?? r);
    if (k.name === "right") setRoute((r) => ROUTES[(ROUTES.indexOf(r) + 1) % ROUTES.length] ?? r);
  });

  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={colors.bg}>
      <Header
        route={route}
        project={activeProject}
        detailId={viewState.detailId ?? null}
        connected={connected}
        connectionError={healthError}
      />

      <box
        flexDirection="row"
        backgroundColor={colors.bg}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={1}
        paddingBottom={1}
        gap={1}
      >
        {(["projects", "tasks", "jobs", "memories", "sessions", "prompts"] as Route[]).map(
          (r, i) => (
            <box
              key={r}
              backgroundColor={route === r ? colors.bgSelected : colors.bgLight}
              border
              borderStyle="single"
              borderColor={route === r ? colors.borderFocus : colors.border}
              paddingLeft={1}
              paddingRight={1}
              paddingTop={0}
              paddingBottom={0}
            >
              <text
                fg={route === r ? colors.text : colors.textDim}
              >{`${i + 1}. ${TAB_LABELS[r]}`}</text>
            </box>
          ),
        )}
        {activeProject && (
          <box
            marginLeft={1}
            backgroundColor={colors.bgSelected}
            border
            borderStyle="single"
            borderColor={colors.border}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={colors.accentAlt}>{`Project ${activeProject}`}</text>
          </box>
        )}
        <box flexGrow={1} justifyContent="center" alignItems="flex-end">
          <text fg={colors.textMuted}>{"1-6 switch • ← → cycle • : command"}</text>
        </box>
      </box>
      <box height={1} backgroundColor={colors.bg}>
        <text fg={colors.border}>{"─".repeat(Math.max(8, width - 2))}</text>
      </box>

      <box
        flexGrow={1}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        paddingTop={1}
        paddingBottom={1}
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
        {route === "prompts" && (
          <PromptsView
            onRegisterKeyHandler={registerViewKeyHandler}
            onStateChange={onViewStateChange}
          />
        )}
      </box>

      <StatusBar route={route} state={viewState} />

      <CommandPalette active={cmdActive} input={cmdInput} commands={commands} />
    </box>
  );
}
