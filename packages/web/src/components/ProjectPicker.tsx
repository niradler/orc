import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronsUpDown, Folder, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { CreateProjectDialog } from "@/components/CreateProjectDialog";
import { CreateTaskDialog } from "@/components/CreateTaskDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useProjects } from "@/hooks/useProjects";
import { workspaceDestination } from "@/lib/workspace-navigation";

export function ProjectPicker({
  projectId,
  onProjectChange,
  compact = false,
  shortcutEnabled = true,
  onNavigate,
}: {
  projectId: string;
  onProjectChange: (id: string) => void;
  compact?: boolean;
  shortcutEnabled?: boolean;
  onNavigate?: () => void;
}) {
  const { data: projects, isLoading, isError } = useProjects({ status: "active" });
  const navigate = useNavigate();
  const { search: routeSearch } = useLocation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [firstTask, setFirstTask] = useState<string | null>(null);
  const name =
    projectId === "all"
      ? "All projects"
      : projectId === "unassigned"
        ? "Unassigned"
        : (projects?.find((p) => p.id === projectId)?.name ?? "Project");
  const create = () => {
    setOpen(false);
    setCreating(true);
  };
  useEffect(() => {
    if (!shortcutEnabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setOpen(false);
        setCreating(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcutEnabled]);
  return (
    <>
      <Popover.Root
        modal
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) setSearch("");
        }}
      >
        <Popover.Trigger asChild>
          <Button
            variant="ghost"
            data-testid="sidebar-project-select"
            data-project-id={projectId}
            aria-label={`Switch project: ${name}`}
            className="h-12 w-full justify-start px-2"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface">
              <Folder className="size-4" />
            </span>
            {!compact && (
              <>
                <span className="min-w-0 flex-1 truncate text-left">{name}</span>
                <ChevronsUpDown className="size-3 text-outline" />
              </>
            )}
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={8}
            className="z-[60] w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface-high p-2 text-on-surface shadow-xl"
            aria-label="Switch project"
          >
            <Input
              data-testid="project-picker-search"
              aria-label="Find a project"
              placeholder="Find a project…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="mb-2"
            />
            <div className="max-h-64 overflow-auto">
              {[
                { id: "all", name: "All projects" },
                { id: "unassigned", name: "Unassigned" },
                ...(projects ?? []),
              ]
                .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
                .map((p) => (
                  <button
                    key={p.id}
                    data-testid={`project-option-${p.id}`}
                    type="button"
                    aria-pressed={projectId === p.id}
                    onClick={() => {
                      onProjectChange(p.id);
                      setOpen(false);
                      setSearch("");
                    }}
                    className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-surface-highest"
                  >
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    {p.id === projectId && <Check className="size-4 text-primary" />}
                  </button>
                ))}
              {isLoading && <p className="p-3 text-sm text-outline">Loading projects…</p>}
              {isError && (
                <p role="alert" className="p-3 text-sm text-error">
                  Projects could not be loaded.
                </p>
              )}
            </div>
            <div className="mt-2 border-t border-border pt-2">
              <Button
                data-testid="project-picker-create"
                variant="ghost"
                className="w-full justify-start"
                onClick={create}
              >
                <Plus />
                Create project<span className="ml-auto text-xs text-outline">⌘/Ctrl ⇧ P</span>
              </Button>
              <Button
                variant="ghost"
                className="w-full justify-start"
                data-testid="nav-projects"
                onClick={() => {
                  setOpen(false);
                  navigate(workspaceDestination("/projects", projectId, routeSearch));
                  onNavigate?.();
                }}
              >
                Manage projects
              </Button>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {creating && (
        <CreateProjectDialog
          open
          onClose={() => setCreating(false)}
          onFirstTask={(id) => {
            onProjectChange(id);
            setFirstTask(id);
          }}
        />
      )}
      {firstTask && (
        <CreateTaskDialog
          open
          defaultProjectId={firstTask}
          onClose={() => setFirstTask(null)}
          onCreated={(id) => {
            setFirstTask(null);
            navigate(workspaceDestination(`/tasks/${id}`, firstTask, routeSearch));
            onNavigate?.();
          }}
        />
      )}
    </>
  );
}
