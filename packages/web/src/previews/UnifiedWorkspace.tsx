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
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Terminal,
  X,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentIcon } from "@/components/AgentIcon";
import { Markdown } from "@/components/Markdown";
import { StateBadge } from "@/components/StateBadge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { AgentState } from "@/lib/agent-state";
import { cn } from "@/lib/utils";
import {
  initialConfiguration,
  type MockConfiguration,
  type ToolTab,
  UnifiedSessionTools,
} from "./UnifiedSessionTools";
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
  updatedAt?: number;
  hasTerminal?: boolean;
}
interface Message {
  id: string;
  text: string;
}
interface Attachment {
  id: string;
  name: string;
  size: number;
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
    hasTerminal: true,
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
  configuration,
  onConfiguration,
}: {
  session: Session;
  host: string;
  onHost: (host: string) => void;
  onProject: (project: string) => void;
  onAgent: (agent: string) => void;
  configuration: MockConfiguration;
  onConfiguration: (patch: Partial<MockConfiguration>) => void;
}): ReactNode {
  return (
    <div
      className="uw-workspace-controls uw-configuration-grid"
      data-testid="shared-workspace-controls"
    >
      <label className="uw-picker">
        <Folder size={15} />
        <span>Project / folder</span>
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
        <span>Execution host</span>
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
        <span>Coding agent</span>
        <select
          aria-label="Agent for new session"
          title="Changing the agent starts a new mock session"
          value={session.agent}
          onChange={(event) => onAgent(event.target.value)}
        >
          {session.agent === "shell" && <option value="shell">Shell (no coding agent)</option>}
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
        </select>
      </label>
      <label className="uw-picker">
        <ShieldCheck size={15} />
        <span>Permissions</span>
        <select
          data-testid="mock-permissions"
          aria-label="Agent permissions"
          value={configuration.permission}
          onChange={(event) => onConfiguration({ permission: event.target.value })}
        >
          <option value="default">Ask in chat</option>
          <option value="acceptEdits">Allow workspace edits</option>
          <option value="bypassPermissions">Full access / bypass permissions</option>
        </select>
      </label>
      <label className="uw-picker">
        <Settings size={15} />
        <span>Reasoning effort</span>
        <select
          aria-label="Reasoning effort"
          value={configuration.effort}
          onChange={(event) => onConfiguration({ effort: event.target.value })}
        >
          <option>Agent default</option>
        </select>
      </label>
      <label className="uw-picker">
        <BookOpen size={15} />
        <span>Tools</span>
        <select
          aria-label="Session tools"
          value={configuration.tools}
          onChange={(event) => onConfiguration({ tools: event.target.value })}
        >
          <option>ORC + host tools</option>
          <option>Host tools only</option>
        </select>
      </label>
      <label className="uw-picker">
        <AgentIcon agent={session.agent} className="size-4" />
        <span>Model</span>
        <select aria-label="Session model">
          <option>Agent default</option>
        </select>
      </label>
      <label className="uw-instructions">
        Session instructions
        <textarea
          aria-label="Session instructions"
          placeholder="Additional instructions for this session"
          value={configuration.instructions}
          onChange={(event) => onConfiguration({ instructions: event.target.value })}
        />
      </label>
      {configuration.permission === "bypassPermissions" && (
        <p className="uw-permission-warning">
          <ShieldCheck size={14} />
          Full access allows actions without approval; Codex also runs without a sandbox. Demo
          configuration only.
        </p>
      )}
      <details className="uw-advanced">
        <summary>Advanced launch options</summary>
        <label className="uw-instructions">
          Agent launch options
          <textarea
            aria-label="Advanced launch options"
            value={configuration.launchOptions}
            onChange={(event) => onConfiguration({ launchOptions: event.target.value })}
            placeholder="Additional agent launch options"
          />
        </label>
        <p>Capabilities and supported options depend on the selected backend.</p>
      </details>
      <p className="uw-config-note">
        Host: {host} · Folder: ~/projects/{session.project.toLowerCase()} · Worktree:{" "}
        {configuration.worktree}
        <br />
        Changing an agent after starting creates a new session. Model and effort choices come from
        the provider in the real UI.
      </p>
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
  configuration,
  onConfiguration,
  onTools,
  attachments,
  onAttachments,
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
  configuration: MockConfiguration;
  onConfiguration: (patch: Partial<MockConfiguration>) => void;
  onTools: (tab: ToolTab) => void;
  attachments: Attachment[];
  onAttachments: (files: Attachment[]) => void;
}): ReactNode {
  const [settingsOpen, setSettingsOpen] = useState(session.title === "New agent terminal");
  const [refreshCount, setRefreshCount] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const canResume =
    session.agent !== "shell" &&
    (!fresh || messages.length > 0 || session.hasTerminal) &&
    (session.state !== "working" || session.hasTerminal);
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
          <button
            type="button"
            aria-label="Show chat"
            disabled={session.agent === "shell"}
            aria-pressed={surface === "chat"}
            onClick={() => onSurface("chat")}
          >
            <MessageSquare size={14} />
            <span>Chat</span>
          </button>
          <button
            type="button"
            aria-label={
              session.agent === "shell"
                ? "Show shell terminal"
                : "Continue same session in terminal"
            }
            title={
              canResume
                ? "Reuse the attached terminal or resume this same coding-agent session"
                : "An existing runtime session is required; wait for the current turn to finish"
            }
            disabled={session.agent !== "shell" && !canResume}
            aria-pressed={surface === "terminal"}
            onClick={() => onSurface("terminal")}
          >
            <Terminal size={14} />
            <span>Terminal</span>
          </button>
        </nav>
        <IconAction label="Open Git and workspace tools" onClick={() => onTools("Changes")}>
          <GitBranch size={16} />
        </IconAction>
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
            {session.agent === "shell"
              ? "Shell"
              : `${session.agent === "codex" ? "Codex" : "Claude"} CLI`}
            <span className="ml-auto">
              {session.agent === "shell" ? "New shell" : "Same coding session"} · {session.id}
            </span>
          </div>
          <pre>
            <span className="text-muted-foreground">
              ~/projects/{session.project.toLowerCase()} {session.branch}
            </span>
            {"\n\n"}
            <span className="text-foreground">
              {session.agent === "shell"
                ? "$ Shell"
                : session.agent === "codex"
                  ? "◈ Codex"
                  : "✳ Claude Code"}
            </span>
            {"\n"}
            <span className="text-muted-foreground">
              {session.agent === "shell"
                ? "Fresh terminal in the selected project"
                : "Resume preview · same agent, runtime identity, folder and host"}
            </span>
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
          {settingsOpen && (
            <section
              className="uw-settings-panel"
              aria-label="Session configuration"
              id={`configuration-${session.id}`}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSettingsOpen(false);
                  event.currentTarget.parentElement
                    ?.querySelector<HTMLButtonElement>("[data-testid=composer-settings]")
                    ?.focus();
                }
              }}
            >
              <header>
                <strong>Session settings</strong>
                <IconAction label="Close session settings" onClick={() => setSettingsOpen(false)}>
                  <X size={15} />
                </IconAction>
              </header>
              <SharedControls
                session={session}
                host={host}
                onHost={onHost}
                onProject={onProject}
                onAgent={onAgent}
                configuration={configuration}
                onConfiguration={onConfiguration}
              />
              <div className="uw-config-links">
                <button type="button" onClick={() => onTools("Worktrees")}>
                  <GitBranch size={14} />
                  Branches & worktrees
                </button>
                <button type="button" onClick={() => onTools("Changes")}>
                  <GitBranch size={14} />
                  Git & diff
                </button>
                <button type="button" onClick={() => fileInput.current?.click()}>
                  <Paperclip size={14} />
                  Attach files
                </button>
              </div>
            </section>
          )}
          <form
            className="uw-composer"
            onSubmit={(event) => {
              event.preventDefault();
              onSend();
            }}
          >
            <input
              ref={fileInput}
              type="file"
              multiple
              className="sr-only"
              tabIndex={-1}
              aria-label={`Attach files to ${session.title}`}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []).map((file) => ({
                  id: crypto.randomUUID(),
                  name: file.name,
                  size: file.size,
                }));
                onAttachments([...attachments, ...files]);
                event.target.value = "";
              }}
            />
            {attachments.length > 0 && (
              <section className="uw-attachments" aria-label="Selected attachments">
                {attachments.map((file) => (
                  <span key={file.id}>
                    <Paperclip size={12} />
                    <span title={file.name}>{file.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove attachment ${file.name}`}
                      onClick={() =>
                        onAttachments(attachments.filter((item) => item.id !== file.id))
                      }
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </section>
            )}
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
              <button
                type="button"
                data-testid="composer-settings"
                className={cn("uw-footer-icon", settingsOpen && "bg-surface-highest")}
                aria-label="Session settings"
                aria-expanded={settingsOpen}
                aria-controls={`configuration-${session.id}`}
                onClick={() => setSettingsOpen(!settingsOpen)}
              >
                <Settings size={15} />
                {configuration.permission !== "default" && <span className="uw-settings-dot" />}
              </button>
              <button
                type="button"
                className="uw-footer-icon"
                aria-label="Refresh session context"
                title="Refresh workspace metadata without clearing the draft"
                onClick={() => setRefreshCount(refreshCount + 1)}
              >
                <RefreshCw size={14} />
              </button>
              <button
                type="button"
                className="uw-footer-icon"
                aria-label="Attach files"
                title="Attach files"
                onClick={() => fileInput.current?.click()}
              >
                <Paperclip size={15} />
              </button>
              <button
                type="button"
                className="uw-footer-chip"
                aria-label={`Project and folder: ${session.project}`}
                title={`~/projects/${session.project.toLowerCase()}`}
                onClick={() => setSettingsOpen(true)}
              >
                <Folder size={14} />
                <span>{session.project}</span>
              </button>
              <button
                type="button"
                className="uw-footer-chip uw-branch-chip"
                aria-label={`Branch and worktree: ${session.branch}`}
                title={`${session.branch} / ${configuration.worktree}`}
                onClick={() => onTools("Worktrees")}
              >
                <GitBranch size={14} />
                <span>{session.branch}</span>
              </button>
              <button
                type="button"
                className="uw-model"
                aria-label="Model: Agent default"
                onClick={() => setSettingsOpen(true)}
              >
                Agent default
                <ChevronDown size={11} />
              </button>
              <Button
                type="submit"
                size="icon"
                aria-label={`Send to ${session.title}`}
                actionHelp={false}
                disabled={!draft.trim() && !attachments.length}
              >
                <ArrowUp size={17} />
              </Button>
            </div>
          </form>
        </div>
        <div className="uw-input-note">
          {refreshCount
            ? `Context refreshed · ${refreshCount} · draft and attachments preserved`
            : surface === "terminal"
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
  const [configurations, setConfigurations] = useState<Record<string, MockConfiguration>>({});
  const [attachments, setAttachments] = useState<Record<string, Attachment[]>>({});
  const [toolsId, setToolsId] = useState<string | null>(null);
  const [toolTab, setToolTab] = useState<ToolTab>("Changes");
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [terminalChoices, setTerminalChoices] = useState(false);
  const [expanded, setExpanded] = useState<string[]>(["ORC"]);
  const [navigation, setNavigation] = useState("projects");
  const [search, setSearch] = useState("");
  const [navOpen, setNavOpen] = useState(true);
  const [phoneNav, setPhoneNav] = useState(false);
  const [sideOpen, setSideOpen] = useState(true);
  const [phonePane, setPhonePane] = useState("primary");
  const [light, setLight] = useState(false);
  const [notice, setNotice] = useState("");
  const allSessions = [
    ...newSessions,
    ...sessions.map((session, index) => ({ ...session, updatedAt: sessions.length - index })),
  ].map((session) => ({ ...session, ...overrides[session.id] }));
  const recentSessions = [...allSessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const homeSession: Session = {
    id: "home",
    title: "New session",
    project: "ORC",
    agent: "codex",
    state: "idle",
    branch: "main",
    ...overrides.home,
  };
  const toolsSession = allSessions.find((session) => session.id === toolsId) ?? homeSession;

  function createSession(project: string, kind = "chat"): void {
    const agent = kind === "shell" ? "shell" : kind === "claude" ? "claude" : "codex";
    const terminal = kind !== "chat";
    const next: Session = {
      id: `new-${crypto.randomUUID()}`,
      title: terminal ? `New ${kind === "agent" ? "agent" : agent} terminal` : "New session",
      project,
      agent,
      branch: "main",
      state: "idle",
      updatedAt: Date.now(),
      hasTerminal: terminal,
    };
    setNewSessions([next, ...newSessions]);
    setSelected(next.id);
    setSurfaces({ ...surfaces, [next.id]: terminal ? "terminal" : "chat" });
    setExpanded(expanded.includes(project) ? expanded : [...expanded, project]);
    setSearch("");
    setLauncherOpen(false);
    setTerminalChoices(false);
    changeScenario("session");
  }

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
    if (toolsId) setToolsId(id);
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
          if (!drafts[id]?.trim() && !attachments[id]?.length) return;
          setMessages({
            ...messages,
            [id]: [
              ...(messages[id] ?? []),
              {
                id: crypto.randomUUID(),
                text: [
                  drafts[id]?.trim() ?? "",
                  ...(attachments[id] ?? []).map((file) => `Attached: ${file.name}`),
                ]
                  .filter(Boolean)
                  .join("\n"),
              },
            ],
          });
          setDrafts({ ...drafts, [id]: "" });
          setAttachments({ ...attachments, [id]: [] });
          setOverrides({ ...overrides, [id]: { ...overrides[id], updatedAt: Date.now() } });
          if (id === "home") {
            setNewSessions([
              {
                ...homeSession,
                title: drafts[id]?.trim().slice(0, 55) || "New conversation",
                updatedAt: Date.now(),
              },
              ...newSessions.filter((item) => item.id !== "home"),
            ]);
            setSelected("home");
            changeScenario("session");
          }
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
          setConfigurations({
            ...configurations,
            [next.id]: configurations[id] ?? initialConfiguration,
          });
          if (id === secondary && scenario === "parallel") setSecondary(next.id);
          else {
            setSelected(next.id);
            if (scenario === "home") changeScenario("session");
          }
        }}
        host={hosts[id] ?? "This computer"}
        onHost={(host) => setHosts({ ...hosts, [id]: host })}
        configuration={configurations[id] ?? initialConfiguration}
        onConfiguration={(patch) =>
          setConfigurations({
            ...configurations,
            [id]: { ...(configurations[id] ?? initialConfiguration), ...patch },
          })
        }
        onTools={(tab) => {
          setToolsId(id);
          setToolTab(tab);
        }}
        attachments={attachments[id] ?? []}
        onAttachments={(files) => setAttachments({ ...attachments, [id]: files })}
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
          <div className="uw-new-session-row">
            <button
              type="button"
              className="uw-new-session"
              onClick={() =>
                createSession(
                  allSessions.find((session) => session.id === selected)?.project ??
                    homeSession.project,
                )
              }
            >
              <Plus size={17} />
              New session
            </button>
            <Popover
              open={launcherOpen}
              onOpenChange={(open) => {
                setLauncherOpen(open);
                if (!open) setTerminalChoices(false);
              }}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="uw-launcher-trigger"
                  aria-label="New session options"
                >
                  <ChevronDown size={15} />
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="uw-launcher-menu"
                aria-label="Create a session or terminal"
              >
                <button
                  type="button"
                  onClick={() =>
                    createSession(
                      allSessions.find((session) => session.id === selected)?.project ?? "ORC",
                    )
                  }
                >
                  <MessageSquare size={15} />
                  <span>
                    New session<small>Web chat · default</small>
                  </span>
                  <Check size={13} className="ml-auto" />
                </button>
                <button
                  type="button"
                  aria-expanded={terminalChoices}
                  onClick={() => setTerminalChoices(!terminalChoices)}
                >
                  <Terminal size={15} />
                  <span>New terminal</span>
                  <ChevronRight size={14} className="ml-auto" />
                </button>
                {terminalChoices && (
                  <section className="uw-terminal-choices" aria-label="New terminal type">
                    {[
                      { kind: "shell", label: "Shell", hint: "Default terminal" },
                      { kind: "codex", label: "Codex", hint: "New coding-agent session" },
                      { kind: "claude", label: "Claude", hint: "New coding-agent session" },
                      {
                        kind: "agent",
                        label: "Agent…",
                        hint: "Choose an agent and launch options",
                      },
                    ].map((item) => (
                      <button
                        type="button"
                        key={item.kind}
                        data-testid={`new-terminal-${item.kind}`}
                        onClick={() =>
                          createSession(
                            allSessions.find((session) => session.id === selected)?.project ??
                              "ORC",
                            item.kind,
                          )
                        }
                      >
                        {item.kind === "shell" ? (
                          <Terminal size={16} />
                        ) : (
                          <AgentIcon agent={item.kind} className="size-4" />
                        )}
                        <span>
                          {item.label}
                          <small>{item.hint}</small>
                        </span>
                      </button>
                    ))}
                  </section>
                )}
              </PopoverContent>
            </Popover>
          </div>
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
              Projects
            </button>
            <button
              type="button"
              aria-pressed={navigation === "all"}
              onClick={() => setNavigation("all")}
            >
              Recents
            </button>
          </div>
          <div className="uw-tree">
            {navigation === "projects"
              ? projects.map((project) => (
                  <div className="uw-project-group" key={project}>
                    <div className="uw-project-heading">
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
                      <button
                        type="button"
                        className="uw-project-add"
                        aria-label={`New session in ${project}`}
                        title={`New session in ${project}`}
                        onClick={() => createSession(project)}
                      >
                        <Plus size={15} />
                      </button>
                    </div>
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
              : recentSessions
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
                label="Toggle theme"
                onClick={() => {
                  document.documentElement.classList.toggle("dark", light);
                  setLight(!light);
                }}
              >
                {light ? <Moon size={15} /> : <Sun size={15} />}
              </IconAction>
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
                {allSessions.find((session) => session.id === selected)?.title ?? "New session"}
              </button>
              <button
                type="button"
                aria-pressed={phonePane === "secondary"}
                onClick={() => setPhonePane("secondary")}
              >
                {allSessions.find((session) => session.id === secondary)?.title ?? "Second session"}
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
        {toolsId && (
          <>
            <button
              type="button"
              className="uw-tools-backdrop"
              aria-label="Close workspace tools overlay"
              onClick={() => setToolsId(null)}
            />
            <UnifiedSessionTools
              key={toolsId}
              project={toolsSession.project}
              branch={toolsSession.branch}
              worktree={(configurations[toolsId] ?? initialConfiguration).worktree}
              tab={toolTab}
              onTab={setToolTab}
              onClose={() => setToolsId(null)}
              onCheckout={(branch, worktree) => {
                setOverrides({ ...overrides, [toolsId]: { ...overrides[toolsId], branch } });
                setConfigurations({
                  ...configurations,
                  [toolsId]: { ...(configurations[toolsId] ?? initialConfiguration), worktree },
                });
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing preview root");
createRoot(root).render(<UnifiedWorkspace />);
