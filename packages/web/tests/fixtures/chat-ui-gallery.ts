export function chatUiGallery(ids: {
  task: string;
  job: string;
  project: string;
  pad: string;
  memory: string;
}) {
  const examples: Record<
    string,
    {
      type: string;
      props: Record<string, unknown>;
      children?: string[];
      on?: Record<string, unknown>;
    }
  > = {
    button: {
      type: "Button",
      props: { label: "Mark demo task for review", variant: "primary" },
      on: { press: { action: "task.update", params: { id: ids.task, status: "review" } } },
    },
    task: { type: "Task", props: { id: ids.task } },
    taskList: { type: "TaskList", props: { projectId: ids.project, limit: 3 } },
    job: { type: "Job", props: { id: ids.job } },
    jobList: { type: "JobList", props: { projectId: ids.project, limit: 3 } },
    project: { type: "Project", props: { id: ids.project } },
    projectList: { type: "ProjectList", props: { limit: 3 } },
    sessions: { type: "SessionList", props: { projectId: ids.project, limit: 3 } },
    memory: { type: "Memory", props: { projectId: ids.project, name: ids.memory } },
    pad: { type: "Pad", props: { id: ids.pad } },
  };
  return {
    root: "main",
    elements: {
      main: {
        type: "Stack",
        props: { gap: "md" },
        children: Object.keys(examples),
      },
      ...examples,
    },
  };
}

export function chatUiGalleryMessage(ids: Parameters<typeof chatUiGallery>[0]): string {
  return `11 components for live data and actions, using example data.\n\n\`\`\`orc-ui\n${JSON.stringify(chatUiGallery(ids), null, 2)}\n\`\`\``;
}
