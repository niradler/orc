import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import {
  Activity,
  ArrowUp,
  BookOpen,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Columns2,
  Folder,
  GitBranch,
  Laptop,
  Maximize2,
  Menu,
  MessageSquare,
  Moon,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Terminal,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentIcon } from "@/components/AgentIcon";
import { Markdown } from "@/components/Markdown";
import { StateBadge } from "@/components/StateBadge";
import { Button } from "@/components/ui/button";
import type { AgentState } from "@/lib/agent-state";
import { cn } from "@/lib/utils";
import "../index.css";
import "./unified-workspace.css";

type Scenario = "home" | "session" | "parallel" | "side";
type Surface = "chat" | "terminal";
interface Session {
  id: string;
  title: string;
  project: string;
  agent: string;
  state: AgentState;
  branch: string;
}
interface Message {
  id: string;
  text: string;
}
const sessions: Session[] = [
  {
    id: "workspace",
    title: "Unify the session workspace",
    project: "ORC",
    agent: "codex",
    state: "needs-you",
    branch: "design/workspace",
  },
  {
    id: "ssh",
    title: "Review SSH host authentication",
    project: "ORC",
    agent: "claude",
    state: "working",
    branch: "fix/ssh-auth",
  },
  {
    id: "checks",
    title: "Add change-aware pre-push checks",
    project: "ORC",
    agent: "codex",
    state: "done",
    branch: "feat/change-checks",
  },
  {
    id: "notifications",
    title: "Keep notification context",
    project: "ORC",
    agent: "claude",
    state: "idle",
    branch: "fix/notifications",
  },
  {
    id: "access",
    title: "Check provider access rules",
    project: "Mishmesh",
    agent: "codex",
    state: "needs-you",
    branch: "feat/providers",
  },
  {
    id: "selection",
    title: "Preserve the box selection",
    project: "3D Preview",
    agent: "claude",
    state: "done",
    branch: "fix/selection",
  },
];
const projects = ["ORC", "Mishmesh", "3D Preview"];
const scenarios: { id: Scenario; label: string }[] = [
  { id: "home", label: "New session" },
  { id: "session", label: "Focused session" },
  { id: "parallel", label: "Parallel sessions" },
  { id: "side", label: "Side chat" },
];
const railItems = [
  { label: "Chat", Icon: MessageSquare },
  { label: "Activity", Icon: Activity },
  { label: "Tasks", Icon: CheckSquare },
  { label: "Terminals", Icon: Terminal },
  { label: "Knowledge", Icon: BookOpen },
];

function IconAction({
  label,
  onClick,
  children,
  active = false,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
}): ReactNode {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      aria-pressed={active}
      actionHelp={false}
      className={cn("uw-icon", active && "bg-surface-highest")}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function SharedControls({
  session,
  host,
  onHost,
  onProject,
  onAgent,
}: {
  session: Session;
  host: string;
  onHost: (host: string) => void;
  onProject: (project: string) => void;
  onAgent: (agent: string) => void;
}): ReactNode {
  return (
    <div className="uw-workspace-controls" data-testid="shared-workspace-controls">
      <label className="uw-picker">
        <Folder size={15} />
        <span className="sr-only">Session folder</span>
        <select
          aria-label="Session folder"
          value={session.project}
          onChange={(event) => onProject(event.target.value)}
        >
          {projects.map((project) => (
            <option key={project}>{project}</option>
          ))}
        </select>
      </label>
      <label className="uw-picker uw-host">
        <Laptop size={15} />
        <span className="sr-only">Execution host</span>
        <select
          aria-label="Execution host"
          value={host}
          onChange={(event) => onHost(event.target.value)}
        >
          <option>This computer</option>
          <option>Development host</option>
        </select>
      </label>
      <label className="uw-picker uw-agent-picker">
        <AgentIcon agent={session.agent} className="size-4" />
        <span className="sr-only">Agent for new session</span>
        <select
          aria-label="Agent for new session"
          title="Changing the agent starts a new mock session"
          value={session.agent}
          onChange={(event) => onAgent(event.target.value)}
        >
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
        </select>
      </label>
    </div>
  );
}

function SessionPane({
  session,
  fresh,
  surface,
  onSurface,
  onSession,
  draft,
  onDraft,
  messages,
  onSend,
  onProject,
  onAgent,
  host,
  onHost,
  compact = false,
  onExpand,
  onSide,
}: {
  session: Session;
  fresh: boolean;
  surface: Surface;
  onSurface: (surface: Surface) => void;
  onSession: (id: string) => void;
  draft: string;
  onDraft: (draft: string) => void;
  messages: Message[];
  onSend: () => void;
  onProject: (project: string) => void;
  onAgent: (agent: string) => void;
  host: string;
  onHost: (host: string) => void;
  compact?: boolean;
  onExpand: () => void;
  onSide: () => void;
}): ReactNode {
  return (
    <section
      className={cn("uw-pane", compact && "uw-pane-compact")}
      aria-label={`${session.title} workspace`}
    >
      <header className="uw-pane-header">
        <label className="uw-session-picker">
          <span className="sr-only">Session in this pane</span>
          <select
            aria-label="Session in this pane"
            value={session.id}
            onChange={(event) => onSession(event.target.value)}
          >
            {!sessions.some((item) => item.id === session.id) && (
              <option value={session.id}>{session.title}</option>
            )}
            {sessions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <nav className="uw-view-switch" aria-label="Session view">
          <button type="button" aria-pressed={surface === "chat"} onClick={() => onSurface("chat")}>
            <MessageSquare size={14} />
            <span>Chat</span>
          </button>
          <button
            type="button"
            aria-pressed={surface === "terminal"}
            onClick={() => onSurface("terminal")}
          >
            <Terminal size={14} />
            <span>Terminal</span>
          </button>
        </nav>
        {compact ? (
          <IconAction label="Expand session" onClick={onExpand}>
            <Maximize2 size={15} />
          </IconAction>
        ) : (
          <IconAction label="Open side chat" onClick={onSide}>
            <PanelRight size={16} />
          </IconAction>
        )}
      </header>
      {!fresh && (
        <div className="uw-session-context">
          <span className="flex gap-1.5 items-center truncate">
            <GitBranch size={13} />
            {session.branch}
          </span>
          <StateBadge state={session.state} />
        </div>
      )}
      {surface === "terminal" ? (
        <div className="uw-terminal" data-testid="unified-terminal">
          <div className="uw-terminal-caption">
            <Terminal size={13} />
            {session.agent === "codex" ? "Codex" : "Claude"} CLI
            <span className="ml-auto">Session transcript preview</span>
          </div>
          <pre>
            <span className="text-muted-foreground">
              ~/projects/{session.project.toLowerCase()} {session.branch}
            </span>
            {"\n\n"}
            <span className="text-foreground">
              {session.agent === "codex" ? "◈ Codex" : "✳ Claude Code"}
            </span>
            {"\n"}
            <span className="text-muted-foreground">Connected to the same workspace</span>
            {"\n\n"}
            <span className="text-foreground">›</span> {session.title}
            {"\n\n"} Reading workspace configuration{"\n"} Inspecting the current changes{"\n"}{" "}
            <span className="text-success">✓</span> Workspace context loaded{"\n\n"}{" "}
            {session.state === "working"
              ? "Reviewing the SSH transport and auth checks…"
              : "Ready for your next instruction."}
            {"\n\n"}
            <span className="text-muted-foreground">────────────────────────────────────</span>
            {"\n\n"} <span className="text-warning">Preview only · no process is running</span>
          </pre>
        </div>
      ) : (
        <div
          className={cn("uw-chat-scroll", fresh && !messages.length && "uw-empty-scroll")}
          data-testid="unified-chat"
        >
          {fresh && !messages.length ? (
            <div className="uw-welcome">
              <div className="uw-welcome-mark">
                <MessageSquare size={30} strokeWidth={1.3} />
              </div>
              <h1>
                What should we build in <span>{session.project}</span>?
              </h1>
              <p>Start a conversation. Keep your work in one place.</p>
            </div>
          ) : (
            <div className="uw-transcript">
              <div className="uw-speaker">You</div>
              <p>
                {session.id === "ssh"
                  ? "Review SSH authentication and check that local and remote agents keep the same workspace context."
                  : "Make chat the default workspace. Let me switch to a terminal and work with another session alongside it."}
              </p>
              <div className="uw-speaker uw-assistant">
                <AgentIcon agent={session.agent} className="size-4" />
                {session.agent === "codex" ? "Codex" : "Claude"}
              </div>
              <Markdown>
                {session.id === "ssh"
                  ? "I’m checking the execution-host boundary and the existing connection flow.\n\n### Current work\n\n- Trace how the selected host reaches the session.\n- Verify that credentials stay out of the UI and logs.\n- Check reconnect behavior before proposing changes.\n\nThe other session can stay open while this review continues."
                  : "The session is the workspace. Chat is the default way to work in it.\n\n### One session, two ways to work\n\nSwitch between **Chat** and **Terminal** in the header. The project, execution host, branch, and agent stay with the session.\n\nOpen a second session beside this one when you want to follow two pieces of work. Each pane has its own conversation and message draft."}
              </Markdown>
              <div className="uw-change-summary">
                <Check size={15} className="text-success" />
                <span>
                  {session.id === "ssh"
                    ? "Host configuration inspected"
                    : "Workspace layout ready for review"}
                </span>
                <span className="ml-auto text-muted-foreground text-xs">Demo</span>
              </div>
              {messages.map((message) => (
                <div key={message.id} className="uw-local-message">
                  <div className="uw-speaker">You</div>
                  <p>{message.text}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="uw-input-area">
        <div className="uw-composer-shell">
          <SharedControls
            session={session}
            host={host}
            onHost={onHost}
            onProject={onProject}
            onAgent={onAgent}
          />
          <form
            className="uw-composer"
            onSubmit={(event) => {
              event.preventDefault();
              onSend();
            }}
          >
            <label className="sr-only" htmlFor={`message-${session.id}`}>
              Message {session.title}
            </label>
            <textarea
              id={`message-${session.id}`}
              aria-label={`Message ${session.title}`}
              value={draft}
              onChange={(event) => onDraft(event.target.value)}
              placeholder={
                surface === "terminal"
                  ? "Send an instruction to this session…"
                  : "Ask anything. @ files, / commands and skills"
              }
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  onSend();
                }
              }}
            />
            <div className="uw-composer-footer">
              <span className="uw-permission" title="Uses the existing permission policy">
                <ShieldCheck size={14} />
                <span>Default permissions</span>
              </span>
              <span className="uw-model">Agent default</span>
              <Button
                type="submit"
                size="icon"
                aria-label={`Send to ${session.title}`}
                actionHelp={false}
                disabled={!draft.trim()}
              >
                <ArrowUp size={17} />
              </Button>
            </div>
          </form>
        </div>
        <div className="uw-input-note">
          {surface === "terminal"
            ? "Same folder, host and agent controls as chat"
            : "Messages stay in this mock · no agents are started"}
        </div>
      </div>
    </section>
  );
}

function UnifiedWorkspace(): ReactNode {
  const queryScenario = new URLSearchParams(window.location.search).get("scene");
  const [scenario, setScenario] = useState<Scenario>(
    scenarios.find((item) => item.id === queryScenario)?.id ?? "home",
  );
  const [selected, setSelected] = useState("workspace");
  const [secondary, setSecondary] = useState("ssh");
  const [surfaces, setSurfaces] = useState<Record<string, Surface>>({ ssh: "terminal" });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [overrides, setOverrides] = useState<Record<string, Partial<Session>>>({});
  const [newSessions, setNewSessions] = useState<Session[]>([]);
  const [hosts, setHosts] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<string[]>(["ORC"]);
  const [navigation, setNavigation] = useState("projects");
  const [search, setSearch] = useState("");
  const [navOpen, setNavOpen] = useState(true);
  const [phoneNav, setPhoneNav] = useState(false);
  const [sideOpen, setSideOpen] = useState(true);
  const [phonePane, setPhonePane] = useState("primary");
  const [light, setLight] = useState(false);
  const [notice, setNotice] = useState("");
  const allSessions = [...newSessions, ...sessions];
  const homeSession: Session = {
    id: "home",
    title: "New session",
    project: "ORC",
    agent: "codex",
    state: "idle",
    branch: "main",
    ...overrides.home,
  };

  function changeScenario(next: Scenario): void {
    setScenario(next);
    if (next === "side") setSideOpen(true);
    setPhoneNav(false);
    const params = new URLSearchParams(window.location.search);
    params.set("scene", next);
    window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
  }

  function selectSession(id: string): void {
    setSelected(id);
    if (scenario === "home") changeScenario("session");
    setPhoneNav(false);
  }

  function renderPane(id: string, compact = false): ReactNode {
    const base = allSessions.find((item) => item.id === id) ?? homeSession;
    const session = { ...base, ...overrides[id] };
    return (
      <SessionPane
        key={id}
        session={session}
        fresh={id === "home" || id.startsWith("new-")}
        surface={surfaces[id] ?? "chat"}
        onSurface={(surface) => setSurfaces({ ...surfaces, [id]: surface })}
        onSession={(next) => {
          if (id === secondary && scenario === "parallel") {
            if (next === selected) setSelected(secondary);
            setSecondary(next);
          } else {
            if (scenario === "parallel" && next === secondary) setSecondary(selected);
            selectSession(next);
          }
        }}
        draft={drafts[id] ?? ""}
        onDraft={(draft) => setDrafts({ ...drafts, [id]: draft })}
        messages={messages[id] ?? []}
        onSend={() => {
          if (!drafts[id]?.trim()) return;
          setMessages({
            ...messages,
            [id]: [...(messages[id] ?? []), { id: crypto.randomUUID(), text: drafts[id].trim() }],
          });
          setDrafts({ ...drafts, [id]: "" });
        }}
        onProject={(project) => setOverrides({ ...overrides, [id]: { ...overrides[id], project } })}
        onAgent={(agent) => {
          if (id === "home" && !messages[id]?.length) {
            setOverrides({ ...overrides, [id]: { ...overrides[id], agent } });
            return;
          }
          const next = {
            ...session,
            id: `new-${crypto.randomUUID()}`,
            title: `New ${agent === "codex" ? "Codex" : "Claude"} session`,
            agent,
            state: "idle" as const,
          };
          setNewSessions([next, ...newSessions]);
          if (id === secondary && scenario === "parallel") setSecondary(next.id);
          else {
            setSelected(next.id);
            if (scenario === "home") changeScenario("session");
          }
        }}
        host={hosts[id] ?? "This computer"}
        onHost={(host) => setHosts({ ...hosts, [id]: host })}
        compact={compact}
        onExpand={() => {
          setSelected(id);
          changeScenario("session");
        }}
        onSide={() => {
          setSelected(id);
          changeScenario("side");
        }}
      />
    );
  }

  function sessionRow(session: Session): ReactNode {
    return (
      <button
        type="button"
        className={cn(
          "uw-session-row",
          scenario !== "home" && selected === session.id && "uw-selected",
        )}
        key={session.id}
        data-testid={`unified-session-${session.id}`}
        aria-pressed={scenario !== "home" && selected === session.id}
        onClick={() => selectSession(session.id)}
      >
        <span className="truncate">{session.title}</span>
        <StateBadge state={session.state} compact />
      </button>
    );
  }

  return (
    <div className="uw-app bg-background text-foreground">
      <div className="uw-review">
        <span>
          Workspace studies <span className="text-muted-foreground">/ interactive mock</span>
        </span>
        <nav aria-label="Mock scenarios">
          {scenarios.map((item) => (
            <button
              type="button"
              key={item.id}
              aria-pressed={scenario === item.id}
              onClick={() => changeScenario(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <IconAction
          label="Toggle theme"
          onClick={() => {
            document.documentElement.classList.toggle("dark", light);
            setLight(!light);
          }}
        >
          {light ? <Moon size={15} /> : <Sun size={15} />}
        </IconAction>
      </div>
      <div className="uw-shell">
        <nav className="uw-rail" aria-label="Workspace">
          <div className="uw-brand">orc</div>
          {railItems.map(({ label, Icon }) => (
            <IconAction
              key={label}
              label={label}
              active={
                (label === "Chat" && scenario !== "side") ||
                (label === "Tasks" && scenario === "side")
              }
              onClick={() => {
                if (label === "Tasks") changeScenario("side");
                else if (label === "Chat") changeScenario("home");
                else if (label === "Terminals") {
                  changeScenario("session");
                  setSurfaces({ ...surfaces, [selected]: "terminal" });
                } else setNotice(`${label} stays accessible in the app rail.`);
              }}
            >
              <Icon size={19} />
            </IconAction>
          ))}
          <div className="mt-auto">
            <IconAction
              label="Settings"
              onClick={() =>
                setNotice("Settings stays in the app rail. This mock changes no configuration.")
              }
            >
              <Settings size={18} />
            </IconAction>
          </div>
        </nav>
        {phoneNav && (
          <button
            type="button"
            aria-label="Close navigation backdrop"
            className="uw-nav-backdrop"
            onClick={() => setPhoneNav(false)}
          />
        )}
        <aside
          aria-label="Projects and sessions"
          className={cn("uw-sidebar", !navOpen && "uw-sidebar-hidden", phoneNav && "uw-phone-nav")}
        >
          <header>
            <strong>Workspace</strong>
            <IconAction
              label="Hide navigation"
              onClick={() => {
                setNavOpen(false);
                setPhoneNav(false);
              }}
            >
              <PanelLeft size={17} />
            </IconAction>
          </header>
          <button type="button" className="uw-new-session" onClick={() => changeScenario("home")}>
            <Plus size={17} />
            New session
          </button>
          <label className="uw-search">
            <Search size={14} />
            <input
              aria-label="Find a session"
              placeholder="Find a session"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <div className="uw-navigation-switch">
            <button
              type="button"
              aria-pressed={navigation === "projects"}
              onClick={() => setNavigation("projects")}
            >
              By project
            </button>
            <button
              type="button"
              aria-pressed={navigation === "all"}
              onClick={() => setNavigation("all")}
            >
              All sessions
            </button>
          </div>
          <div className="uw-tree">
            {navigation === "projects"
              ? projects.map((project) => (
                  <div className="uw-project-group" key={project}>
                    <button
                      type="button"
                      className="uw-project-row"
                      aria-expanded={expanded.includes(project)}
                      onClick={() =>
                        setExpanded(
                          expanded.includes(project)
                            ? expanded.filter((item) => item !== project)
                            : [...expanded, project],
                        )
                      }
                    >
                      {expanded.includes(project) ? (
                        <ChevronDown size={12} />
                      ) : (
                        <ChevronRight size={12} />
                      )}
                      <Folder size={16} />
                      <span>{project}</span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {allSessions.filter((item) => item.project === project).length}
                      </span>
                    </button>
                    {(expanded.includes(project) || !!search) && (
                      <div className="uw-project-sessions">
                        {allSessions
                          .filter(
                            (item) =>
                              item.project === project &&
                              item.title.toLowerCase().includes(search.toLowerCase()),
                          )
                          .map(sessionRow)}
                      </div>
                    )}
                  </div>
                ))
              : allSessions
                  .filter((item) => item.title.toLowerCase().includes(search.toLowerCase()))
                  .map(sessionRow)}
            {!allSessions.some((item) =>
              item.title.toLowerCase().includes(search.toLowerCase()),
            ) && <p className="p-3 text-muted-foreground text-xs">No matching sessions</p>}
          </div>
          <footer>
            <span className="size-1.5 rounded-full bg-success" />
            Local workspace<span className="ml-auto">2 working</span>
          </footer>
        </aside>
        <main className="uw-main">
          <div className="uw-global-header">
            <IconAction
              label="Show navigation"
              onClick={() => {
                setNavOpen(true);
                setPhoneNav(true);
              }}
            >
              <Menu size={17} />
            </IconAction>
            <div className="uw-global-breadcrumb">
              {scenario === "side" ? (
                <>
                  ORC<span>/</span>Tasks
                </>
              ) : (
                <>
                  ORC<span>/</span>
                  {scenario === "home" ? "New session" : "Sessions"}
                </>
              )}
            </div>
            <div className="ml-auto flex gap-1">
              <IconAction
                label="Show parallel sessions"
                active={scenario === "parallel"}
                onClick={() => changeScenario(scenario === "parallel" ? "session" : "parallel")}
              >
                <Columns2 size={17} />
              </IconAction>
              <IconAction
                label={scenario === "side" && sideOpen ? "Hide side chat" : "Show side chat"}
                active={scenario === "side" && sideOpen}
                onClick={() => {
                  if (scenario === "side") setSideOpen(!sideOpen);
                  else {
                    if (scenario === "home") setSelected("home");
                    changeScenario("side");
                  }
                }}
              >
                <PanelRight size={17} />
              </IconAction>
            </div>
          </div>
          {scenario === "parallel" && (
            <nav className="uw-phone-pane-tabs" aria-label="Visible session">
              <button
                type="button"
                aria-pressed={phonePane === "primary"}
                onClick={() => setPhonePane("primary")}
              >
                Session 1
              </button>
              <button
                type="button"
                aria-pressed={phonePane === "secondary"}
                onClick={() => setPhonePane("secondary")}
              >
                Session 2
              </button>
            </nav>
          )}
          <div
            className={cn(
              "uw-content",
              scenario === "parallel" && "uw-parallel",
              scenario === "side" && "uw-side-layout",
              scenario === "side" && sideOpen && "uw-side-open",
            )}
          >
            {scenario === "side" ? (
              <>
                <section className="uw-task-page">
                  <div className="uw-task-heading">
                    <div>
                      <h1>Tasks</h1>
                      <p>
                        ORC <span>8 active</span>
                      </p>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => setNotice("Task creation is outside this layout mock.")}
                    >
                      <Plus size={15} />
                      New task
                    </Button>
                  </div>
                  <div className="uw-task-tabs">
                    <span>Active</span>
                    <span className="text-muted-foreground">Board</span>
                    <span className="ml-auto text-muted-foreground">All agents</span>
                  </div>
                  {[
                    { title: "Unify the session workspace", state: "In progress", agent: "codex" },
                    {
                      title: "Review SSH host authentication",
                      state: "In progress",
                      agent: "claude",
                    },
                    { title: "Add change-aware pre-push checks", state: "Review", agent: "codex" },
                    { title: "Keep notification context", state: "Todo", agent: "claude" },
                  ].map((task) => (
                    <button
                      type="button"
                      className="uw-task-row"
                      key={task.title}
                      onClick={() => setNotice(`Selected task: ${task.title}`)}
                    >
                      <CheckSquare size={16} />
                      <span>{task.title}</span>
                      <span className="uw-task-status">{task.state}</span>
                      <AgentIcon agent={task.agent} className="size-4" />
                    </button>
                  ))}
                  <div className="uw-task-hint">
                    <MessageSquare size={18} />
                    <p>
                      Keep working here.
                      <br />
                      <span>Chat stays beside the current page.</span>
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    className="uw-return-chat"
                    onClick={() => changeScenario("session")}
                  >
                    <Maximize2 size={15} />
                    Return to full-page chat
                  </Button>
                </section>
                {sideOpen && <div className="uw-side-chat">{renderPane(selected, true)}</div>}
              </>
            ) : (
              <>
                <div
                  className={cn(
                    "uw-primary-pane",
                    scenario === "parallel" && phonePane !== "primary" && "uw-phone-pane-hidden",
                  )}
                >
                  {renderPane(scenario === "home" ? "home" : selected)}
                </div>
                {scenario === "parallel" && (
                  <div
                    className={cn(
                      "uw-secondary-pane",
                      phonePane !== "secondary" && "uw-phone-pane-hidden",
                    )}
                  >
                    {renderPane(secondary, true)}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="uw-notice" role="status">
            {notice || "Layout preview · demo sessions · no commands or agents run"}
          </div>
        </main>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing preview root");
createRoot(root).render(<UnifiedWorkspace />);
