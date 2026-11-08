import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import {
  Activity,
  ArrowUp,
  BookOpen,
  CheckSquare,
  ChevronDown,
  Folder,
  GitBranch,
  Menu,
  MessageSquare,
  Moon,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  Settings,
  Sun,
  Terminal,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentIcon } from "@/components/AgentIcon";
import { Markdown } from "@/components/Markdown";
import { SessionRowContent } from "@/components/SessionRowContent";
import { StateBadge } from "@/components/StateBadge";
import { Button } from "@/components/ui/button";
import { usePanelWidth } from "@/hooks/usePanelWidth";
import type { AgentState } from "@/lib/agent-state";
import { cn } from "@/lib/utils";
import "../index.css";
import "./workspace-draft.css";

interface DraftSession {
  id: string;
  title: string;
  project: string;
  branch: string;
  agent: string;
  state: AgentState;
  source: string;
  time: string;
}

const projects = ["ORC", "Mishmesh", "3D Preview"];
const initialSessions: DraftSession[] = [
  {
    id: "layout",
    title: "Rethink the agent workspace",
    project: "ORC",
    branch: "design/workspace",
    agent: "codex",
    state: "needs-you",
    source: "Chat",
    time: "now",
  },
  {
    id: "auth",
    title: "Review SSH host authentication",
    project: "ORC",
    branch: "fix/ssh-auth",
    agent: "claude",
    state: "working",
    source: "Terminal",
    time: "2m",
  },
  {
    id: "mesh",
    title: "Check provider access rules",
    project: "Mishmesh",
    branch: "feat/providers",
    agent: "codex",
    state: "needs-you",
    source: "Discovered",
    time: "5m",
  },
  {
    id: "preview",
    title: "Preserve the box selection",
    project: "3D Preview",
    branch: "fix/selection",
    agent: "claude",
    state: "done",
    source: "Chat",
    time: "12m",
  },
  {
    id: "notifications",
    title: "Keep notification context",
    project: "ORC",
    branch: "fix/notifications",
    agent: "codex",
    state: "done",
    source: "Chat",
    time: "24m",
  },
  {
    id: "tests",
    title: "Validate the Linux build",
    project: "ORC",
    branch: "chore/build",
    agent: "claude",
    state: "working",
    source: "Terminal",
    time: "38m",
  },
  {
    id: "ports",
    title: "Workspace port allocation",
    project: "Mishmesh",
    branch: "feat/ports",
    agent: "codex",
    state: "idle",
    source: "Chat",
    time: "1h",
  },
  {
    id: "docs",
    title: "Document session navigation",
    project: "ORC",
    branch: "docs/sessions",
    agent: "claude",
    state: "idle",
    source: "Chat",
    time: "2h",
  },
];
const filters = ["All", "Needs you", "Working", "Done"] as const;
type Filter = (typeof filters)[number];
const filterStates: Partial<Record<Filter, AgentState>> = {
  "Needs you": "needs-you",
  Working: "working",
  Done: "done",
};

function IconButton({
  label,
  children,
  active,
  onClick,
}: {
  label: string;
  children: ReactNode;
  active?: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn("draft-icon", active && "bg-surface-highest")}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function WorkspaceDraft(): ReactNode {
  const [sessions, setSessions] = useState(initialSessions);
  const [selected, setSelected] = useState("layout");
  const [project, setProject] = useState("All projects");
  const [filter, setFilter] = useState<Filter>("All");
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState("unified");
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [listOpen, setListOpen] = useState(true);
  const [mobileList, setMobileList] = useState(false);
  const [inspector, setInspector] = useState(false);
  const [inspectorTab, setInspectorTab] = useState("Context");
  const [terminal, setTerminal] = useState(false);
  const [light, setLight] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, { id: string; text: string }[]>>({});
  const [notice, setNotice] = useState("");
  const panel = usePanelWidth({
    storageKey: "orc_draft_session_width",
    initial: 296,
    min: 248,
    max: 400,
  });
  const session = sessions.find((item) => item.id === selected) ?? sessions[0];
  const scoped = sessions.filter((item) => project === "All projects" || item.project === project);
  const visible = scoped.filter(
    (item) =>
      (!filterStates[filter] || item.state === filterStates[filter]) &&
      `${item.title} ${item.project} ${item.branch}`.toLowerCase().includes(query.toLowerCase()),
  );
  const draft = drafts[session.id] ?? "";

  function chooseProject(next: string): void {
    setProject(next);
    const nextSession = sessions.find((item) => next === "All projects" || item.project === next);
    if (nextSession) setSelected(nextSession.id);
  }

  function newSession(): void {
    const id = `draft-${sessions.length}`;
    const nextProject = project === "All projects" ? session.project : project;
    setSessions([
      {
        id,
        title: "New conversation",
        project: nextProject,
        branch: "main",
        agent: "codex",
        state: "idle",
        source: "Chat",
        time: "now",
      },
      ...sessions,
    ]);
    setSelected(id);
    setFilter("All");
    setQuery("");
    setMobileList(false);
  }

  function submitDraft(): void {
    if (!draft.trim()) return;
    setMessages({
      ...messages,
      [session.id]: [
        ...(messages[session.id] ?? []),
        { id: crypto.randomUUID(), text: draft.trim() },
      ],
    });
    setDrafts({ ...drafts, [session.id]: "" });
    setNotice("Message added to this mock conversation. No agent was started.");
  }

  const projectList = (
    <nav className="draft-projects" aria-label="Project scope">
      {["All projects", ...projects].map((name) => (
        <button
          type="button"
          key={name}
          aria-pressed={project === name}
          className={cn("draft-project", project === name && "bg-surface-highest text-foreground")}
          onClick={() => chooseProject(name)}
        >
          <Folder size={15} />
          <span className="truncate">{name}</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {sessions.filter(
              (item) =>
                (name === "All projects" || item.project === name) && item.state === "needs-you",
            ).length || ""}
          </span>
        </button>
      ))}
    </nav>
  );

  return (
    <div className="draft-app bg-background text-foreground" data-testid="workspace-draft">
      <div className="draft-review border-b border-border bg-surface">
        <span className="font-medium">
          Workspace draft <span className="text-muted-foreground font-normal">/ demo data</span>
        </span>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="draft-layout">
            Project layout
          </label>
          <select
            id="draft-layout"
            value={layout}
            onChange={(event) => setLayout(event.target.value)}
            className="draft-select"
          >
            <option value="unified">A · Unified sidebar</option>
            <option value="separate">B · Separate projects</option>
          </select>
          <IconButton
            label="Toggle color theme"
            onClick={() => {
              document.documentElement.classList.toggle("dark", light);
              setLight(!light);
            }}
          >
            {light ? <Moon size={16} /> : <Sun size={16} />}
          </IconButton>
        </div>
      </div>
      <div className="draft-shell">
        <nav aria-label="ORC workspace" className="draft-rail border-r border-border bg-sidebar">
          <div className="draft-brand" title="ORC">
            o<span>r</span>c
          </div>
          {[
            [Activity, "Activity"],
            [MessageSquare, "Chat"],
            [CheckSquare, "Tasks"],
            [Terminal, "Terminals"],
            [BookOpen, "Knowledge"],
          ].map(([Icon, label]) => {
            const RailIcon = Icon as typeof Activity;
            return (
              <IconButton
                key={String(label)}
                label={String(label)}
                active={label === "Chat"}
                onClick={() => {
                  if (label === "Chat") setMobileList(true);
                  else
                    setNotice(
                      `${label} stays in the app rail. This draft focuses on the chat workspace.`,
                    );
                }}
              >
                <RailIcon size={18} />
              </IconButton>
            );
          })}
          <div className="mt-auto">
            <IconButton
              label="Settings"
              onClick={() =>
                setNotice("Settings stays in the app rail. No settings are changed by this draft.")
              }
            >
              <Settings size={18} />
            </IconButton>
          </div>
        </nav>
        {layout === "separate" && (
          <aside className="draft-project-column border-r border-border bg-sidebar">
            <div className="draft-section-heading">Projects</div>
            {projectList}
            <p className="px-3 mt-auto pb-4 text-xs text-muted-foreground">
              Project scope applies to the session list.
            </p>
          </aside>
        )}
        {mobileList && (
          <button
            type="button"
            className="draft-backdrop"
            aria-label="Close session navigation"
            onClick={() => setMobileList(false)}
          />
        )}
        <aside
          aria-label="Sessions"
          className={cn(
            "draft-list border-r border-border bg-sidebar",
            !listOpen && "draft-list-collapsed",
            mobileList && "draft-list-mobile",
          )}
          style={{ "--draft-list-width": `${panel.width}px` } as React.CSSProperties}
        >
          <div className="draft-list-heading">
            <strong className="font-medium">Workspace</strong>
            <IconButton
              label="Close sessions"
              onClick={() => {
                setMobileList(false);
                setListOpen(false);
              }}
            >
              <PanelLeft size={16} />
            </IconButton>
          </div>
          <div className={cn(layout === "separate" && "draft-mobile-projects")}>
            <button
              type="button"
              className="draft-section-heading w-full"
              aria-expanded={projectsOpen}
              onClick={() => setProjectsOpen(!projectsOpen)}
            >
              <ChevronDown size={13} className={cn(!projectsOpen && "-rotate-90")} />
              Projects <span className="ml-auto text-xs font-normal">{projects.length}</span>
            </button>
            {projectsOpen && projectList}
          </div>
          <div className="draft-session-toolbar">
            <span className="font-medium">
              Sessions <span className="text-muted-foreground font-normal">{scoped.length}</span>
            </span>
            <IconButton label="New session" onClick={newSession}>
              <Plus size={16} />
            </IconButton>
          </div>
          <label className="draft-search border border-border">
            <Search size={14} />
            <input
              aria-label="Search sessions"
              placeholder="Search sessions"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <nav className="draft-filters" aria-label="Session state">
            {filters.map((item) => (
              <button
                type="button"
                key={item}
                aria-pressed={filter === item}
                className={cn(filter === item && "bg-surface-highest text-foreground")}
                onClick={() => setFilter(item)}
              >
                {item}
                <span>
                  {item === "All"
                    ? scoped.length
                    : scoped.filter((entry) => entry.state === filterStates[item]).length}
                </span>
              </button>
            ))}
          </nav>
          <div className="draft-session-list">
            {visible.map((item) => (
              <button
                type="button"
                key={item.id}
                data-testid={`draft-session-${item.id}`}
                aria-pressed={selected === item.id}
                className={cn("draft-session", selected === item.id && "bg-surface-highest")}
                onClick={() => {
                  setSelected(item.id);
                  setMobileList(false);
                  setNotice("");
                }}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <SessionRowContent
                    agent={item.agent}
                    title={item.title}
                    state={item.state}
                    stateTestId={`draft-state-${item.id}`}
                  />
                </span>
                <span className="draft-session-meta">
                  <span className="truncate">
                    {item.project} <span className="text-outline">/</span> {item.branch}
                  </span>
                  <span>{item.time}</span>
                </span>
              </button>
            ))}
            {!visible.length && (
              <p className="p-4 text-sm text-muted-foreground">
                No matching sessions. Try another project or filter.
              </p>
            )}
          </div>
          <div className="draft-list-footer">
            <span className="size-1.5 rounded-full bg-success" />
            Local workspace
            <span className="ml-auto">
              {sessions.filter((item) => item.state === "working").length} working
            </span>
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: shared pointer and keyboard resize behavior */}
          <div
            role="separator"
            aria-label="Resize sessions"
            aria-orientation="vertical"
            aria-valuenow={panel.width}
            aria-valuemin={248}
            aria-valuemax={400}
            tabIndex={0}
            className="draft-splitter"
            {...panel.handleProps}
          />
        </aside>
        <main className="draft-main">
          <header className="draft-chat-header border-b border-border">
            <IconButton
              label="Show sessions"
              active={listOpen}
              onClick={() => {
                setListOpen(true);
                setMobileList(true);
              }}
            >
              <Menu size={17} />
            </IconButton>
            <div className="min-w-0 flex-1">
              <div className="draft-breadcrumb">
                <span>{session.project}</span>
                <span>/</span>
                <strong className="truncate font-medium text-foreground">{session.title}</strong>
              </div>
            </div>
            <IconButton
              label="Toggle terminal"
              active={terminal}
              onClick={() => setTerminal(!terminal)}
            >
              <PanelBottom size={17} />
            </IconButton>
            <IconButton
              label="Toggle inspector"
              active={inspector}
              onClick={() => setInspector(!inspector)}
            >
              <PanelRight size={17} />
            </IconButton>
          </header>
          <div className="draft-context border-b border-border">
            <span className="flex items-center gap-1.5 truncate">
              <GitBranch size={13} />
              {session.branch}
            </span>
            <span className="draft-source">{session.source} session</span>
            <span className="ml-auto">
              <StateBadge state={session.state} />
            </span>
          </div>
          <div className="draft-conversation" key={session.id}>
            <div className="draft-reading">
              <div className="draft-turn-label">You</div>
              <p className="draft-user-message">
                {session.id === "layout"
                  ? "Let's make projects and sessions easier to move between. Keep the conversation the main focus, like a desktop coding app."
                  : `Continue working on ${session.title.toLowerCase()}. Show me the current state and the next decision.`}
              </p>
              <div className="draft-turn-label flex items-center gap-2">
                <AgentIcon agent={session.agent} className="size-4" />
                {session.agent === "codex" ? "Codex" : "Claude"}
                <span className="text-muted-foreground font-normal">
                  {session.source === "Discovered" ? "Connected session" : "Workspace agent"}
                </span>
              </div>
              <Markdown>
                {session.id === "layout"
                  ? "Projects should set the scope. Sessions should show what needs attention. The conversation should keep its space.\n\n### One place to pick up work\n\n- **Projects above sessions:** switch context without opening a second full sidebar.\n- **One flat session list:** chat, terminal agents, and discovered sessions share the same rows.\n- **Conversation in the center:** branch and state stay visible; tools open when needed.\n\nThe inspector and terminal are closed by default. Open either from the header when you want to inspect the work."
                  : "The session context stays visible while you read. Switching projects narrows the list; switching sessions keeps a separate message draft for each conversation.\n\n### Ready to continue\n\nThis is a layout demonstration. Changes, terminal output, and conversation content here use local demo data."}
              </Markdown>
              {session.id === "layout" && (
                <div className="draft-decision border border-border bg-surface">
                  <div className="flex items-center gap-2 font-medium">
                    <StateBadge state="needs-you" /> <span>Layout ready for review</span>
                  </div>
                  <p>
                    Try A and B above. A keeps more room for the conversation; B keeps every project
                    visible in its own column.
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setInspector(true)}>
                      Inspect context
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setLayout(layout === "unified" ? "separate" : "unified");
                      }}
                    >
                      Compare layout {layout === "unified" ? "B" : "A"}
                    </Button>
                  </div>
                </div>
              )}
              {(messages[session.id] ?? []).map((message) => (
                <div key={message.id} className="mt-6">
                  <div className="draft-turn-label">You</div>
                  <p className="whitespace-pre-wrap">{message.text}</p>
                  <p className="text-xs text-muted-foreground mt-3">
                    Draft preview · message kept in this tab only
                  </p>
                </div>
              ))}
            </div>
          </div>
          <div className="draft-composer-area">
            <form
              className="draft-composer border border-control-border bg-surface"
              onSubmit={(event) => {
                event.preventDefault();
                submitDraft();
              }}
            >
              <label className="sr-only" htmlFor="draft-message">
                Message this session
              </label>
              <textarea
                id="draft-message"
                placeholder="Ask anything. @ files, / commands and skills"
                value={draft}
                onChange={(event) => setDrafts({ ...drafts, [session.id]: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submitDraft();
                  }
                }}
              />
              <div className="draft-composer-controls">
                <span className="draft-chip">
                  <Folder size={13} />
                  {session.project}
                </span>
                <span className="draft-chip draft-branch-chip">
                  <GitBranch size={13} />
                  {session.branch}
                </span>
                <span className="draft-chip ml-auto">
                  <AgentIcon agent={session.agent} className="size-3.5" />
                  {session.agent === "codex" ? "Codex" : "Claude"}
                  <span className="text-muted-foreground">Agent default</span>
                </span>
                <Button
                  type="submit"
                  size="icon"
                  aria-label="Send mock message"
                  disabled={!draft.trim()}
                >
                  <ArrowUp size={16} />
                </Button>
              </div>
            </form>
            <div className="draft-composer-caption" role="status">
              {notice ||
                "Interactive layout mock · messages stay in this tab · no agents or commands run"}
            </div>
          </div>
          {terminal && (
            <section
              aria-label="Terminal preview"
              className="draft-terminal border-t border-border"
            >
              <div className="flex items-center gap-2 text-xs mb-3">
                <Terminal size={14} />
                Terminal{" "}
                <span className="text-muted-foreground">/ {session.project} / preview</span>
                <button
                  type="button"
                  aria-label="Close terminal"
                  className="ml-auto draft-icon"
                  onClick={() => setTerminal(false)}
                >
                  <X size={15} />
                </button>
              </div>
              <pre>
                <span className="text-muted-foreground">$</span> bun run typecheck{"\n"}
                <span className="text-success">✓</span> Demo output — no shell command executed
              </pre>
            </section>
          )}
        </main>
        {inspector && (
          <>
            <button
              type="button"
              aria-label="Close inspector overlay"
              className="draft-inspector-backdrop"
              onClick={() => setInspector(false)}
            />
            <aside
              aria-label="Session inspector"
              className="draft-inspector border-l border-border bg-background"
            >
              <header className="flex items-center justify-between p-3 border-b border-border">
                <span className="font-medium">Session inspector</span>
                <IconButton label="Close inspector" onClick={() => setInspector(false)}>
                  <X size={16} />
                </IconButton>
              </header>
              <div className="draft-inspector-tabs">
                {["Context", "Files", "Diff", "PR"].map((tab) => (
                  <button
                    type="button"
                    key={tab}
                    aria-pressed={inspectorTab === tab}
                    className={cn(inspectorTab === tab && "bg-surface-highest text-foreground")}
                    onClick={() => setInspectorTab(tab)}
                  >
                    {tab}
                  </button>
                ))}
              </div>
              <div className="p-4">
                {inspectorTab === "Context" ? (
                  <>
                    <h2 className="font-medium mb-5">{session.project}</h2>
                    <dl className="draft-details">
                      {[
                        ["Host", "Local"],
                        [
                          "Folder",
                          `~/projects/${session.project.toLowerCase().replace(/ /g, "-")}`,
                        ],
                        ["Branch", session.branch],
                        ["Source", session.source],
                        ["Changes", "3 files · +84 −21"],
                        ["Linked task", "Workspace layout review"],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <p className="text-xs text-muted-foreground mt-6">
                      Example context for layout review. Git and task actions are not connected.
                    </p>
                  </>
                ) : (
                  <>
                    <h2 className="font-medium mb-3">{inspectorTab} preview</h2>
                    {inspectorTab === "Files" && (
                      <div className="space-y-3 text-sm">
                        <p>WorkspaceSidebar.tsx</p>
                        <p>SessionHome.tsx</p>
                        <p>ChatPanel.tsx</p>
                      </div>
                    )}
                    {inspectorTab === "Diff" && (
                      <pre className="text-xs leading-6">
                        <span className="text-muted-foreground">Workspace layout</span>
                        {"\n"}
                        <span className="text-error">− competing sidebars</span>
                        {"\n"}
                        <span className="text-success">+ project scope + sessions</span>
                      </pre>
                    )}
                    {inspectorTab === "PR" && (
                      <p className="text-sm text-muted-foreground">
                        No pull request linked to this demo.
                      </p>
                    )}
                    <p className="text-xs mt-6 text-muted-foreground">Illustrative content only.</p>
                  </>
                )}
              </div>
            </aside>
          </>
        )}
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing draft root");
createRoot(root).render(<WorkspaceDraft />);
