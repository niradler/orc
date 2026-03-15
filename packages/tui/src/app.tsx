import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { createOrcClient } from "@orc/sdk";
import { useCallback, useMemo, useState } from "react";
import { CommandPalette } from "./components/command-palette.js";
import { Header } from "./components/header.js";
import { StatusBar } from "./components/status-bar.js";
import { useCommand } from "./hooks/use-command.js";
import { usePolling } from "./hooks/use-polling.js";
import { colors } from "./theme.js";
import type { Command, Route } from "./types.js";
import { JobsView } from "./views/jobs.js";
import { MemoriesView } from "./views/memories.js";
import { ProjectsView } from "./views/projects.js";
import { PromptsView } from "./views/prompts.js";
import { SessionsView } from "./views/sessions.js";
import { TasksView } from "./views/tasks.js";

const client = createOrcClient();

export function App() {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [route, setRoute] = useState<Route>("tasks");
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  const { data: healthData } = usePolling(() => client.health.check(), 10000);
  const connected = !!healthData;

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

  const { active: cmdActive, input: cmdInput } = useCommand(commands);

  useKeyboard((key) => {
    if (cmdActive) return;
    if (key.name === "1") setRoute("projects");
    if (key.name === "2") setRoute("tasks");
    if (key.name === "3") setRoute("jobs");
    if (key.name === "4") setRoute("memories");
    if (key.name === "5") setRoute("sessions");
    if (key.name === "6") setRoute("prompts");
    if (key.name === "q" && key.ctrl) renderer.destroy();
  });

  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={colors.bg}>
      <Header route={route} project={activeProject} detailId={null} connected={connected} />

      <box flexDirection="row" height={1} backgroundColor={colors.bgLight} paddingLeft={1} gap={1}>
        {(["projects", "tasks", "jobs", "memories", "sessions", "prompts"] as Route[]).map(
          (r, i) => (
            <box
              key={r}
              {...(route === r ? { backgroundColor: colors.bgHighlight } : {})}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={route === r ? colors.accent : colors.textDim}>{`${i + 1}:${r}`}</text>
            </box>
          ),
        )}
        {activeProject && (
          <text fg={colors.accentAlt} paddingLeft={2}>
            {`[${activeProject}]`}
          </text>
        )}
      </box>

      <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>
        {route === "projects" && <ProjectsView onSelectProject={selectProject} />}
        {route === "tasks" && <TasksView projectId={activeProjectId} />}
        {route === "jobs" && <JobsView projectId={activeProjectId} />}
        {route === "memories" && <MemoriesView projectId={activeProjectId} />}
        {route === "sessions" && <SessionsView />}
        {route === "prompts" && <PromptsView />}
      </box>

      <StatusBar mode="list" filterQuery="" filterActive={false} itemCount={0} filteredCount={0} />

      <CommandPalette active={cmdActive} input={cmdInput} commands={commands} />
    </box>
  );
}
