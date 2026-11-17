export function chatUiGallery(ids: {
  task: string;
  job: string;
  project: string;
  pad: string;
  session: string;
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
    sessions: { type: "SessionList", props: { projectId: ids.project, limit: 3 } },
    pad: { type: "Scratchpad", props: { id: ids.pad } },
    metric: {
      type: "Metric",
      props: { label: "Open tasks", value: 12, unit: "tasks", hint: "+3 this week", trend: "up" },
    },
    progress: { type: "Progress", props: { value: 62, label: "Migration" } },
    table: {
      type: "Table",
      props: {
        columns: ["Task", "Status", "Owner"],
        rows: [
          ["Render components in chat", "Doing", "codex"],
          ["Review the catalogue with a truncated value that keeps going", "Done", "claude"],
        ],
        caption: "Example work",
      },
    },
    sparkline: {
      type: "Sparkline",
      props: { values: [3, 5, 4, 8, 6, 9, 7], label: "Builds per day" },
    },
    chart: {
      type: "Chart",
      props: {
        kind: "line",
        title: "Sessions per day",
        labels: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        series: [
          { name: "Chat", values: [4, 7, 5, 9, 6] },
          { name: "Terminal", values: [2, 3, 4, 3, 5] },
        ],
      },
    },
    keyValue: {
      type: "KeyValue",
      props: {
        title: "Runtime",
        items: [
          { label: "Host", value: "This ORC server" },
          { label: "Model", value: "codex-mini" },
        ],
      },
    },
    callout: {
      type: "Callout",
      props: { tone: "warn", text: "The recorded cache lifetime has elapsed.", title: "Heads up" },
    },
    html: {
      type: "Html",
      props: {
        title: "Inline HTML",
        height: "short",
        html: '<!doctype html><html><body style="font-family:sans-serif;margin:12px"><h1 style="font-size:16px">Inline HTML</h1><p>Sandboxed, no network.</p></body></html>',
      },
    },
    usage: { type: "SessionUsage", props: { sessionId: ids.session } },
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
  return `16 components for live data, actions and presentation, using example data.\n\n\`\`\`orc-ui\n${JSON.stringify(chatUiGallery(ids), null, 2)}\n\`\`\``;
}
