import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Command, FileText, Folder, Search, TerminalSquare, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "@/api/client";
import { CreateProjectDialog } from "@/components/CreateProjectDialog";
import { CreateTaskDialog } from "@/components/CreateTaskDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useProjects } from "@/hooks/useProjects";
import { commandMatches, searchHitPath } from "@/lib/command-palette";
import { cwdTail, TERMINAL_KINDS } from "@/lib/terminal-kinds";
import { TERMINAL_PALETTE_EVENT, type TerminalPaletteRequest } from "@/lib/terminal-palette";
import { terminalStatus } from "@/lib/terminal-presentation";
import { useTerminals } from "@/lib/terminals";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { WORKSPACE_SECTIONS, workspaceDestination } from "@/lib/workspace-navigation";

type Entry = {
  id: string;
  title: string;
  detail: string;
  tooltip?: string;
  group: string;
  run: () => void;
};
const FILTERS = [
  "All",
  "Actions",
  "Terminals",
  "Tasks",
  "Projects",
  "Knowledge",
  "Sessions",
  "Jobs",
] as const;
type Filter = (typeof FILTERS)[number];
const GROUPS = {
  task: "Tasks",
  project: "Projects",
  memory: "Knowledge",
  session: "Sessions",
  job: "Jobs",
} as const;

export function CommandPalette({
  projectId,
  onProjectChange,
  onOpenChat,
}: {
  projectId: string;
  onProjectChange: (id: string) => void;
  onOpenChat: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const {
    terminals,
    connectionOf,
    error: terminalError,
    refetch: refetchTerminals,
  } = useTerminals();
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [filter, setFilter] = useState<Filter>("All");
  const [scoped, setScoped] = useState(false);
  const [active, setActive] = useState(0);
  const [dialog, setDialog] = useState<"task" | "project" | null>(null);
  const [taskProject, setTaskProject] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const selectedTerminal = useRef(false);
  const [terminalTarget, setTerminalTarget] = useState<TerminalPaletteRequest | null>(null);
  const recentTerminals = useRef<string[]>([]);
  const scope = scoped && projectId !== "all" ? projectId : undefined;
  const { data: projects } = useProjects({ status: "active" });
  const ssh = useQuery({
    queryKey: ["ssh"],
    queryFn: () => api.ssh.get(),
    enabled: open && filter === "Terminals",
  });

  const changeOpen = useCallback((value: boolean) => {
    setOpen(value);
    if (value) {
      selectedTerminal.current = false;
      returnFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setTerminalTarget(null);
      setQuery("");
      setDebounced("");
      setActive(0);
      setFilter("All");
    }
  }, []);
  useEffect(() => {
    const id = /^\/terminals\/([^/]+)$/.exec(location.pathname)?.[1];
    if (id)
      recentTerminals.current = [
        id,
        ...recentTerminals.current.filter((item) => item !== id),
      ].slice(0, 32);
  }, [location.pathname]);
  useEffect(() => {
    const openTerminals = (event: Event) => {
      const request = (event as CustomEvent<TerminalPaletteRequest>).detail;
      changeOpen(true);
      setTerminalTarget(request);
      setFilter("Terminals");
    };
    window.addEventListener(TERMINAL_PALETTE_EVENT, openTerminals);
    return () => window.removeEventListener(TERMINAL_PALETTE_EVENT, openTerminals);
  }, [changeOpen]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "k"
      ) {
        // Respect editors/dialogs that already own keyboard focus.
        if (document.querySelector('[role="dialog"]') && !open) return;
        event.preventDefault();
        changeOpen(!open);
      }
    };
    const onTerminalKey = (event: KeyboardEvent) => {
      if (
        !(event.target instanceof HTMLElement) ||
        !event.target.closest('[data-testid="terminal-viewport"]')
      )
        return;
      onKey(event);
      if (event.defaultPrevented) event.stopPropagation();
    };
    window.addEventListener("keydown", onTerminalKey, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onTerminalKey, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, changeOpen]);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  const searching = open && debounced.length >= 2 && filter !== "Actions" && filter !== "Terminals";
  const resources = useQuery({
    queryKey: ["palette-search", debounced, scope],
    queryFn: () => api.search(debounced, scope),
    enabled: searching,
    retry: false,
    staleTime: 15_000,
  });
  const documents = useQuery({
    queryKey: ["palette-documents", debounced, scope],
    queryFn: () =>
      api.kb.search(
        {
          query: debounced,
          scope: !scope ? "all" : scope === "unassigned" ? "global" : "default",
          limit: 6,
          mode: "lexical",
        },
        scope && scope !== "unassigned" ? scope : undefined,
      ),
    enabled: searching && (filter === "All" || filter === "Knowledge"),
    retry: false,
    staleTime: 15_000,
  });
  const sessions = useQuery({
    queryKey: ["palette-live-sessions", debounced],
    queryFn: () => api.sessions.search({ q: debounced, limit: 20 }),
    enabled: searching && (filter === "All" || filter === "Sessions"),
    retry: false,
    staleTime: 15_000,
  });
  const go = (path: string, project = projectId) =>
    navigate(workspaceDestination(path, project, location.search));
  const entries: Entry[] = [];
  if (filter === "All" || filter === "Terminals") {
    const recent = recentTerminals.current;
    const ordered = [...terminals].sort((left, right) => {
      const rank = (id: string) => (recent.includes(id) ? recent.indexOf(id) : recent.length);
      return rank(left.id) - rank(right.id) || right.created_at.localeCompare(left.created_at);
    });
    for (const terminal of ordered) {
      const kind = TERMINAL_KINDS[terminal.kind].label;
      const detail = `${kind} · ${terminal.host ?? "Local"} · ${terminalStatus(terminal, connectionOf(terminal.id))} · ${cwdTail(terminal.cwd) || "Home"}`;
      if (!commandMatches(terminal.name, `${detail} ${terminal.kind} ${terminal.cwd ?? ""}`, query))
        continue;
      entries.push({
        id: `terminal-${terminal.id}`,
        title: terminal.name,
        tooltip: `${terminal.name}\n${terminal.host ?? "Local"}\n${terminal.cwd ?? "Home"}`,
        detail: `${terminalTarget?.currentId === terminal.id ? "Current · " : ""}${detail}`,
        group: "Terminals",
        run: () => {
          recentTerminals.current = [
            terminal.id,
            ...recent.filter((id) => id !== terminal.id),
          ].slice(0, 32);
          if (terminalTarget) terminalTarget.select(terminal.id);
          else go(`/terminals/${encodeURIComponent(terminal.id)}`);
        },
      });
    }
  }
  if (filter === "Terminals" && query.trim()) {
    const hosts: (string | null)[] = [null, ...(ssh.data?.supported ? ssh.data.hosts : [])];
    for (const host of hosts) {
      const label = host ?? "Local";
      if (!commandMatches(label, "new terminal shell host", query)) continue;
      entries.push({
        id: `new-terminal-host-${host ?? "local"}`,
        title: `New terminal on ${label}`,
        detail: "Choose an agent and folder before launching",
        group: "Terminals",
        run: () => go(`/terminals?new=1&terminalHost=${encodeURIComponent(host ?? "")}`),
      });
    }
  }
  const add = (
    id: string,
    title: string,
    detail: string,
    group: string,
    run: () => void,
    keywords = "",
  ) => {
    if (
      (filter === "All" || filter === group || (filter === "Actions" && group === "Navigation")) &&
      commandMatches(title, `${detail} ${keywords}`, query)
    )
      entries.push({ id, title, detail, group, run });
  };
  add(
    "new-task",
    "Create task",
    "Choose details before saving",
    "Actions",
    () => {
      setTaskProject(projectId);
      setDialog("task");
    },
    "new add todo",
  );
  add(
    "new-project",
    "Create project",
    "Set up a workspace",
    "Actions",
    () => setDialog("project"),
    "new add folder",
  );
  add(
    "new-terminal",
    "New terminal",
    "Choose an agent or shell and working folder",
    "Actions",
    () => go("/terminals?new=1"),
    "launch start agent claude codex",
  );
  add(
    "chat",
    "Open chat",
    "Chat with your configured agent",
    "Actions",
    onOpenChat,
    "ask assistant",
  );
  add(
    "theme",
    `Switch to ${theme === "dark" ? "light" : "dark"} theme`,
    "Change appearance",
    "Actions",
    () => setTheme(theme === "dark" ? "light" : "dark"),
    "toggle theme mode",
  );
  add(
    "refresh",
    "Refresh workspace",
    "Reload cached dashboard data",
    "Actions",
    () => {
      void queryClient.invalidateQueries();
    },
    "reload sync",
  );
  for (const section of WORKSPACE_SECTIONS)
    for (const page of section.pages)
      add(`nav-${page.id}`, `Go to ${page.label}`, section.label, "Navigation", () =>
        go(page.path),
      );
  add("nav-projects", "Manage projects", "Projects", "Navigation", () => go("/projects"));
  for (const project of [
    { id: "all", name: "All projects" },
    { id: "unassigned", name: "Unassigned" },
    ...(projects ?? []),
  ])
    add(
      `switch-${project.id}`,
      `Switch to ${project.name}`,
      "Change project scope",
      "Projects",
      () => onProjectChange(project.id),
    );
  // Server search also matches bodies and IDs, so do not filter hits again by title.
  if (searching && query.trim() === debounced) {
    for (const hit of resources.data?.results ?? []) {
      const group = GROUPS[hit.kind];
      if (filter !== "All" && filter !== group) continue;
      entries.push({
        id: `${hit.kind}-${hit.project_id}-${hit.id}`,
        title: hit.title,
        detail: `${hit.kind} · ${hit.project_name ?? "Unassigned / global"}${hit.detail ? ` · ${hit.detail}` : ""}`,
        group,
        run: () => go(searchHitPath(hit), hit.project_id ?? "unassigned"),
      });
    }
    for (const doc of documents.data?.hits ?? []) {
      if (filter !== "All" && filter !== "Knowledge") continue;
      entries.push({
        id: `doc-${doc.document_id}`,
        title: doc.title || doc.path,
        detail: `${doc.kb_name} · ${(doc.passages[0]?.snippet ?? doc.path).replace(/[«»]/g, "")}`,
        group: "Knowledge",
        run: () =>
          go(
            `/knowledge/base?kb=${encodeURIComponent(doc.kb_id)}&document=${encodeURIComponent(doc.document_id)}`,
            scope ?? "all",
          ),
      });
    }
  }
  if (searching && query.trim() === debounced && (filter === "All" || filter === "Sessions")) {
    for (const session of sessions.data?.hits ?? []) {
      if (
        scope &&
        (scope === "unassigned" ? session.project_id !== null : session.project_id !== scope)
      )
        continue;
      entries.push({
        id: `live-${session.id}`,
        title: session.summary || `${session.agent} session`,
        detail: `${session.agent} · ${session.status} · ${session.snippets[0] ?? session.cwd ?? "Session"}`,
        group: "Sessions",
        run: () =>
          go(
            `/sessions?session=${encodeURIComponent(session.id)}`,
            session.project_id ?? "unassigned",
          ),
      });
    }
  }
  const groupOrder = [
    "Actions",
    "Terminals",
    "Tasks",
    "Projects",
    "Knowledge",
    "Sessions",
    "Jobs",
    "Navigation",
  ];
  entries.sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group));
  const selected = Math.min(active, Math.max(0, entries.length - 1));
  const execute = (entry: Entry) => {
    selectedTerminal.current = entry.id.startsWith("terminal-");
    setOpen(false);
    entry.run();
  };
  useEffect(() => {
    if (open)
      document.getElementById(`palette-option-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [selected, open]);
  const loading =
    (searching && (resources.isFetching || documents.isFetching || sessions.isFetching)) ||
    (filter !== "Terminals" && query.trim() !== debounced);

  return (
    <>
      <Button
        ref={trigger}
        data-testid="command-palette-open"
        variant="outline"
        size="sm"
        aria-label="Search and run commands"
        aria-keyshortcuts="Control+k Meta+k"
        onClick={() => changeOpen(true)}
      >
        <Search className="size-4" />
        <span className="hidden lg:inline">Search anything…</span>
        <kbd className="hidden sm:inline text-xs text-outline">⌘/Ctrl K</kbd>
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          data-testid="command-palette"
          className="top-[10%] translate-y-0 grid-cols-1 min-w-0 max-w-2xl w-[calc(100vw-1rem)] gap-0 p-0 overflow-hidden"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (selectedTerminal.current) {
              requestAnimationFrame(() => {
                const pane = document.querySelector(
                  '[data-testid="workspace-pane"][data-active="true"]',
                );
                const target =
                  pane?.querySelector<HTMLElement>('[data-testid="terminal-viewport"] textarea') ??
                  pane?.querySelector<HTMLElement>('[data-testid="pane-terminal"]');
                target?.focus();
              });
              return;
            }
            if (!dialog) {
              if (returnFocus.current?.isConnected) returnFocus.current.focus();
              else trigger.current?.focus();
            }
          }}
        >
          <DialogTitle className="sr-only">Search and run commands</DialogTitle>
          <DialogDescription className="sr-only">
            Search across projects or choose an action. Use arrow keys and Enter to select.
          </DialogDescription>
          <div className="flex items-center gap-3 border-b border-border px-4 pr-12 py-3">
            <Search className="size-5 shrink-0 text-outline" />
            <Input
              ref={input}
              data-testid="command-palette-input"
              role="combobox"
              aria-label={filter === "Terminals" ? "Find terminal" : "Search anything"}
              aria-expanded="true"
              aria-controls="palette-results"
              aria-autocomplete="list"
              aria-activedescendant={entries.length ? `palette-option-${selected}` : undefined}
              placeholder={
                filter === "Terminals"
                  ? "Find terminal by name, folder, agent or host…"
                  : "Search anything, or run a command…"
              }
              maxLength={200}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              className="border-0 bg-transparent shadow-none focus-visible:ring-0 px-0"
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive(
                    (selected + (event.key === "ArrowDown" ? 1 : -1) + entries.length) %
                      (entries.length || 1),
                  );
                }
                if (event.key === "Enter" && entries[selected]) {
                  event.preventDefault();
                  execute(entries[selected]);
                }
              }}
            />
          </div>
          <fieldset
            className="flex min-w-0 items-center gap-1 overflow-x-auto border-b border-border p-2"
            aria-label="Filter results"
          >
            {FILTERS.map((value) => (
              <button
                type="button"
                key={value}
                data-testid={`palette-filter-${value.toLowerCase()}`}
                aria-pressed={filter === value}
                className={cn(
                  "shrink-0 rounded-md px-3 py-2 text-xs focus-visible:outline focus-visible:outline-2",
                  filter === value
                    ? "bg-surface-highest text-on-surface"
                    : "text-outline hover:bg-surface",
                )}
                onClick={() => {
                  setFilter(value);
                  setActive(0);
                  input.current?.focus();
                }}
              >
                {value}
              </button>
            ))}
          </fieldset>
          <div className="flex items-center justify-between gap-2 px-4 py-2 text-xs text-outline">
            {filter === "Terminals" ? (
              <span>
                {query.trim()
                  ? "Existing terminals · Enter to switch"
                  : "Recent terminals · Enter to switch"}
              </span>
            ) : (
              <>
                <span>{scope ? "Current project" : "Across all projects"}</span>
                {projectId !== "all" && (
                  <button
                    type="button"
                    data-testid="palette-scope"
                    aria-pressed={scoped}
                    className="rounded px-2 py-1 text-on-surface hover:bg-surface-highest"
                    onClick={() => {
                      setScoped(!scoped);
                      setActive(0);
                    }}
                  >
                    {scoped ? "Search all projects" : "Only this project"}
                  </button>
                )}
              </>
            )}
          </div>
          <div
            id="palette-results"
            role="listbox"
            aria-label="Commands and search results"
            aria-busy={loading}
            className="max-h-[50dvh] overflow-y-auto px-2 pb-2"
          >
            {entries.map((entry, index) => (
              <div key={entry.id}>
                {(index === 0 || entries[index - 1].group !== entry.group) && (
                  <div role="presentation" className="px-3 pb-1 pt-3 text-xs text-outline">
                    {entry.group}
                  </div>
                )}
                <button
                  type="button"
                  tabIndex={-1}
                  id={`palette-option-${index}`}
                  role="option"
                  aria-selected={index === selected}
                  data-testid="palette-result"
                  data-command-id={entry.id}
                  title={entry.tooltip ?? `${entry.title}\n${entry.detail}`}
                  onPointerMove={() => setActive(index)}
                  onClick={() => execute(entry)}
                  className={cn(
                    "flex w-full text-left min-h-12 cursor-pointer items-center gap-3 rounded-md px-3 py-2",
                    index === selected ? "bg-surface-highest" : "hover:bg-surface",
                  )}
                >
                  {entry.group === "Terminals" ? (
                    <TerminalSquare className="size-4 shrink-0 text-outline" />
                  ) : entry.group === "Actions" ? (
                    <Zap className="size-4 shrink-0 text-outline" />
                  ) : entry.group === "Projects" ? (
                    <Folder className="size-4 shrink-0 text-outline" />
                  ) : entry.group === "Navigation" ? (
                    <Command className="size-4 shrink-0 text-outline" />
                  ) : (
                    <FileText className="size-4 shrink-0 text-outline" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-on-surface">{entry.title}</div>
                    <div className="truncate text-xs text-outline">{entry.detail}</div>
                  </div>
                  {index === selected && (
                    <ArrowUpRight aria-hidden className="size-4 shrink-0 text-outline" />
                  )}
                </button>
              </div>
            ))}
          </div>
          <div
            role="status"
            data-testid="palette-status"
            className="px-4 py-2 text-xs text-outline"
          >
            {loading
              ? "Searching…"
              : !entries.length
                ? filter === "Terminals"
                  ? "No matching terminals. Launch one from New terminal."
                  : query.trim().length < 2
                    ? "Type at least 2 characters to search records."
                    : "No results. Try a different search or category."
                : `${entries.length} ${entries.length === 1 ? "result" : "results"}`}
          </div>
          {(filter === "Terminals" || filter === "All") && terminalError && (
            <div
              role="alert"
              className="flex items-center justify-between px-4 py-2 text-xs text-error"
            >
              Terminal list unavailable.
              <Button
                size="sm"
                variant="ghost"
                data-testid="palette-terminals-retry"
                onClick={refetchTerminals}
              >
                Retry
              </Button>
            </div>
          )}
          {searching && (resources.isError || documents.isError || sessions.isError) && (
            <div
              role="alert"
              className="flex items-center justify-between px-4 py-2 text-xs text-error"
            >
              {resources.isError
                ? "Resource search unavailable."
                : documents.isError
                  ? "Knowledge base search unavailable."
                  : "Live session search unavailable."}{" "}
              <Button
                size="sm"
                variant="ghost"
                data-testid="palette-retry"
                onClick={() => {
                  if (resources.isError) void resources.refetch();
                  if (documents.isError) void documents.refetch();
                  if (sessions.isError) void sessions.refetch();
                }}
              >
                Retry
              </Button>
            </div>
          )}
          <footer className="flex justify-between gap-2 border-t border-border px-4 py-3 text-xs text-outline">
            <span>
              ↑ ↓ Navigate <span className="ml-3">↵ Open</span>
            </span>
            <span>Esc Close</span>
          </footer>
        </DialogContent>
      </Dialog>
      {dialog === "task" && (
        <CreateTaskDialog
          open
          defaultProjectId={
            taskProject && taskProject !== "all" && taskProject !== "unassigned"
              ? taskProject
              : undefined
          }
          onClose={() => {
            setDialog(null);
            trigger.current?.focus();
          }}
          onCreated={(id) => go(`/tasks/${encodeURIComponent(id)}`, "all")}
        />
      )}
      {dialog === "project" && (
        <CreateProjectDialog
          open
          onClose={() => {
            setDialog(null);
            trigger.current?.focus();
          }}
          onFirstTask={(id) => {
            onProjectChange(id);
            setTaskProject(id);
            setDialog("task");
          }}
        />
      )}
    </>
  );
}
