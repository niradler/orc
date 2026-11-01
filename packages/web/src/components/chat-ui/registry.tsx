import { type Components, defineRegistry } from "@json-render/react";
import { chatUiCatalog } from "@orc/core/chat-ui";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  JobCard,
  JobList,
  MemoryCard,
  PadCard,
  ProjectCard,
  ProjectList,
  SessionList,
  TaskCard,
  TaskList,
} from "./entities";

const GAP = { sm: "gap-1.5", md: "gap-3", lg: "gap-5" } as const;
const BUTTON_VARIANT = {
  primary: "default",
  secondary: "outline",
  destructive: "destructive",
} as const;

const components: Components<typeof chatUiCatalog> = {
  Stack: ({ props, children }) => (
    <div
      className={cn(
        "flex min-w-0",
        props.direction === "horizontal" ? "flex-row flex-wrap items-center" : "flex-col",
        GAP[props.gap ?? "md"],
      )}
    >
      {children}
    </div>
  ),
  Button: ({ props, emit, loading }) => (
    <Button
      type="button"
      size="sm"
      className="w-fit"
      data-testid="chat-ui-button"
      variant={BUTTON_VARIANT[props.variant ?? "secondary"]}
      disabled={loading}
      onClick={() => emit("press")}
    >
      {props.label}
    </Button>
  ),
  Task: ({ props }) => <TaskCard id={props.id} />,
  TaskList: ({ props }) => (
    <TaskList projectId={props.projectId} status={props.status} limit={props.limit} />
  ),
  Job: ({ props }) => <JobCard id={props.id} />,
  JobList: ({ props }) => (
    <JobList projectId={props.projectId} enabled={props.enabled} limit={props.limit} />
  ),
  Project: ({ props }) => <ProjectCard id={props.id} />,
  ProjectList: ({ props }) => <ProjectList status={props.status} limit={props.limit} />,
  SessionList: ({ props }) => <SessionList projectId={props.projectId} limit={props.limit} />,
  Memory: ({ props }) => <MemoryCard projectId={props.projectId} name={props.name} />,
  Pad: ({ props }) => <PadCard id={props.id} />,
};

// Actions are dispatched through JSONUIProvider handlers (see ChatUiRenderer), which need
// React Query and the confirm dialog, so the static registry declares none.
type RegistryOptions = Parameters<typeof defineRegistry<typeof chatUiCatalog>>[1];
export const { registry } = defineRegistry(chatUiCatalog, {
  components,
} as unknown as RegistryOptions);
