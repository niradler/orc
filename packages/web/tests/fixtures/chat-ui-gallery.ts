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
    heading: { type: "Heading", props: { text: "Component gallery" } },
    text: {
      type: "Text",
      props: { text: "Example data in an isolated development workspace.", muted: true },
    },
    markdown: {
      type: "Markdown",
      props: { text: "**Markdown** supports lists, links, and `inline code`." },
    },
    badge: { type: "Badge", props: { label: "Live preview", tone: "success" } },
    grid: { type: "Grid", props: { columns: 2 }, children: ["stat", "progress"] },
    stat: {
      type: "Stat",
      props: { label: "Components", value: 26, hint: "16 generic · 10 live entities" },
    },
    progress: { type: "Progress", props: { value: 65, label: "Example progress" } },
    card: {
      type: "Card",
      props: { title: "Card", description: "An optional section title and description." },
      children: ["keyValue"],
    },
    keyValue: {
      type: "KeyValue",
      props: {
        items: [
          { label: "Project", value: "Chat UI demo", href: `/projects/${ids.project}` },
          { label: "State", value: "Reviewing" },
        ],
      },
    },
    table: {
      type: "Table",
      props: {
        columns: [
          { key: "name", label: "Component" },
          { key: "state", label: "Status" },
        ],
        rows: [{ name: "Live task", state: "Connected", href: `/tasks/${ids.task}` }],
        linkKey: "href",
      },
    },
    alert: {
      type: "Alert",
      props: {
        title: "Example notice",
        text: "Actions use the signed-in user's permissions.",
        tone: "info",
      },
    },
    link: { type: "Link", props: { label: "Open demo project", href: `/projects/${ids.project}` } },
    button: {
      type: "Button",
      props: { label: "Mark demo task for review", variant: "primary" },
      on: { press: { action: "task.update", params: { id: ids.task, status: "review" } } },
    },
    divider: { type: "Divider", props: {} },
    code: { type: "Code", props: { code: "bun run dev", language: "sh" } },
    task: { type: "Task", props: { id: ids.task } },
    taskList: { type: "TaskList", props: { projectId: ids.project, limit: 3 } },
    job: { type: "Job", props: { id: ids.job } },
    jobList: { type: "JobList", props: { projectId: ids.project, limit: 3 } },
    project: { type: "Project", props: { id: ids.project } },
    projectList: { type: "ProjectList", props: { limit: 3 } },
    sessions: { type: "SessionList", props: { projectId: ids.project, limit: 3 } },
    memory: { type: "Memory", props: { projectId: ids.project, name: ids.memory } },
    pad: { type: "Pad", props: { id: ids.pad } },
    skill: { type: "Skill", props: { name: "orc-platform" } },
  };
  return {
    root: "main",
    elements: {
      main: {
        type: "Stack",
        props: { gap: "md" },
        children: Object.keys(examples).filter(
          (key) => !["stat", "progress", "keyValue"].includes(key),
        ),
      },
      ...examples,
    },
  };
}

export function chatUiGalleryMessage(ids: Parameters<typeof chatUiGallery>[0]): string {
  return `All 26 catalog components, using example data.\n\n\`\`\`orc-ui\n${JSON.stringify(chatUiGallery(ids), null, 2)}\n\`\`\``;
}
