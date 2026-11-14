import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Files,
  GitBranch,
  GitPullRequest,
  List,
  SquareTerminal,
} from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { api, type GithubItem } from "@/api/client";
import type { SessionContext } from "@/components/SessionHome";
import { FilePanel } from "@/components/terminals/FilePanel";
import { GitPanelBody } from "@/components/terminals/GitPanel";
import { PullReviewPanel } from "@/components/terminals/PullReviewPanel";
import {
  useWorkspaceByPath,
  workspacePortRange,
  workspaceSetupLabel,
} from "@/components/WorkspaceStatus";
import type { SessionHomeNav } from "@/hooks/useSessionHome";
import { fileChangeState } from "@/lib/git-status";
import type { InspectorTab } from "@/lib/session-home";
import { cn } from "@/lib/utils";

const TABS: { id: InspectorTab; label: string; Icon: typeof GitBranch }[] = [
  { id: "overview", label: "Overview", Icon: GitBranch },
  { id: "diff", label: "Changes", Icon: List },
  { id: "pr", label: "Pull request", Icon: GitPullRequest },
  { id: "files", label: "Files", Icon: Files },
];

function CiBadge({ ci }: { ci: NonNullable<GithubItem["ci"]> }) {
  const tone =
    ci.state === "success"
      ? "text-secondary"
      : ci.state === "failure"
        ? "text-error"
        : ci.state === "pending"
          ? "text-progress"
          : "text-muted-foreground";
  const label =
    ci.state === "success"
      ? "Checks passing"
      : ci.state === "failure"
        ? "Checks failing"
        : ci.state === "pending"
          ? "Checks running"
          : "No checks";
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", tone)}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {label}
      {ci.total > 0 && <span className="text-muted-foreground">· {ci.total}</span>}
    </span>
  );
}

function MobileOverview({ context, home }: { context: SessionContext; home: SessionHomeNav }) {
  const git = context.gitTerminal;
  const status = useQuery({
    queryKey: ["git", git?.id, "status"],
    queryFn: () => api.git.status(git?.id ?? ""),
    enabled: !!git,
  });
  const github = useQuery({
    queryKey: ["git", git?.id, "github", status.data?.branch],
    queryFn: () => api.git.checkoutGithub(git?.id ?? ""),
    enabled: !!git && !!status.data?.root,
    staleTime: 60_000,
  });
  const branch = status.data?.branch;
  const pr = branch
    ? github.data?.items.find(
        (item) =>
          item.kind === "pr" &&
          item.branch === branch &&
          /^https:\/\/github[.]com\//.test(item.url),
      )
    : undefined;
  const files = status.data?.files ?? [];
  const staged = files.filter((file) => fileChangeState(file).staged).length;
  const conflicts = files.filter((file) => fileChangeState(file).conflict).length;
  const task = context.session?.task;
  const { data: workspace } = useWorkspaceByPath(context.cwd);
  const ports = workspace ? workspacePortRange(workspace) : null;
  if (!git)
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <SquareTerminal size={22} className="text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">
          Git activity needs a running terminal in this session&apos;s folder.
        </p>
        <button
          type="button"
          data-testid="session-inspector-open-terminal"
          onClick={() => home.go({ drawer: true })}
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-control-border px-4 text-sm hover:bg-surface"
        >
          <SquareTerminal size={15} />
          Open terminal
        </button>
        <dl className="mt-4 w-full space-y-3 text-left text-sm">
          <OverviewRow label="Host" testId="session-inspector-host">
            {context.host ?? "local"}
          </OverviewRow>
          <OverviewRow label="Folder" testId="session-inspector-folder">
            {context.cwd}
          </OverviewRow>
        </dl>
      </div>
    );
  return (
    <div className="space-y-4 p-3" data-testid="session-inspector-overview">
      <section className="rounded-lg border border-border bg-surface p-3">
        <div className="flex items-start gap-2.5">
          <GitBranch
            size={17}
            className="mt-0.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <p
              data-testid="session-inspector-branch"
              className="truncate font-mono text-[13px] font-medium"
              title={branch ?? undefined}
            >
              {status.isPending ? "Loading branch…" : (branch ?? "Detached HEAD")}
            </p>
            <p
              data-testid="session-inspector-folder"
              className="mt-0.5 truncate text-xs text-muted-foreground"
              title={context.cwd ?? undefined}
            >
              {context.cwd}
              {context.host ? ` · ${context.host}` : ""}
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="session-inspector-changes"
            onClick={() => home.go({ inspector: "diff" }, { replace: true })}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-surface-highest px-3 text-[13px] hover:bg-surface-high"
          >
            {files.length} {files.length === 1 ? "file" : "files"} changed
            <ChevronRight size={13} aria-hidden="true" className="text-muted-foreground" />
          </button>
          {staged > 0 && <span className="text-xs text-muted-foreground">{staged} staged</span>}
          {conflicts > 0 && <span className="text-xs text-error">{conflicts} conflicts</span>}
        </div>
      </section>
      <section className="rounded-lg border border-border bg-surface p-3">
        <div className="flex items-start gap-2.5">
          <GitPullRequest
            size={17}
            className="mt-0.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            {github.isPending ? (
              <p className="text-sm text-muted-foreground">Checking pull requests…</p>
            ) : pr ? (
              <>
                <p
                  data-testid="session-inspector-pull-request"
                  className="text-[13px] font-medium leading-snug"
                >
                  #{pr.number} {pr.title}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span
                    className={cn(
                      "text-xs",
                      pr.state === "open"
                        ? "text-secondary"
                        : pr.state === "merged"
                          ? "text-progress"
                          : "text-muted-foreground",
                    )}
                  >
                    {pr.state === "open" ? "Open" : pr.state}
                  </span>
                  {pr.ci && <CiBadge ci={pr.ci} />}
                </div>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="session-inspector-review-pr"
                    onClick={() => home.go({ inspector: "pr" }, { replace: true })}
                    className="inline-flex min-h-9 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground"
                  >
                    Review diff
                  </button>
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-control-border px-3 text-[13px] hover:bg-surface"
                  >
                    GitHub
                    <ExternalLink size={12} aria-hidden="true" />
                  </a>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {github.data?.unavailable_reason === "no_remote"
                  ? "This checkout has no GitHub origin remote."
                  : github.data?.auth === "none"
                    ? "GitHub authentication is unavailable on this host."
                    : "No open PR for this branch."}
              </p>
            )}
          </div>
        </div>
      </section>
      <dl className="space-y-3 px-1 text-sm">
        <OverviewRow label="Host" testId="session-inspector-host">
          {context.host ?? "local"}
        </OverviewRow>
        <OverviewRow label="Task">
          {task && (
            <Link className="text-primary hover:underline" to={`/tasks/${task.id}`}>
              {task.title}
            </Link>
          )}
        </OverviewRow>
        <OverviewRow label="Workspace ports">{ports}</OverviewRow>
        <OverviewRow label="Workspace setup">
          {workspace ? workspaceSetupLabel(workspace) : null}
        </OverviewRow>
        <OverviewRow label="Preview">
          {workspace?.preview_url && (
            <a
              className="text-primary hover:underline"
              href={workspace.preview_url}
              target="_blank"
              rel="noreferrer"
            >
              Open preview
            </a>
          )}
        </OverviewRow>
      </dl>
    </div>
  );
}

function OverviewRow({
  label,
  testId,
  children,
}: {
  label: string;
  testId?: string;
  children: ReactNode;
}) {
  if (!children) return null;
  return (
    <div data-testid={testId ?? `session-inspector-${label.toLowerCase().replace(" ", "-")}`}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

/** The phone Inspector page: git overview, working-tree diff, PR review and the
 *  checkout's files, each a full-width tab driven by the `inspector` URL param. */
export function MobileInspectorPage({
  context,
  home,
}: {
  context: SessionContext;
  home: SessionHomeNav;
}) {
  const tab: InspectorTab = home.inspector ?? "overview";
  const git = context.gitTerminal;
  const root = useRef<HTMLElement>(null);
  const close = () => home.go({ inspector: null });
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus and Escape bind once when the page opens
  useEffect(() => {
    root.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) home.go({ inspector: null });
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.querySelector<HTMLElement>('[data-testid="session-inspector-toggle"]')?.focus();
    };
  }, []);
  const status = useQuery({
    queryKey: ["git", git?.id, "status"],
    queryFn: () => api.git.status(git?.id ?? ""),
    enabled: !!git,
  });
  const github = useQuery({
    queryKey: ["git", git?.id, "github", status.data?.branch],
    queryFn: () => api.git.checkoutGithub(git?.id ?? ""),
    enabled: !!git && !!status.data?.root,
    staleTime: 60_000,
  });
  const branch = status.data?.branch;
  const pull = branch
    ? github.data?.items.find(
        (item) =>
          item.kind === "pr" &&
          item.branch === branch &&
          /^https:\/\/github[.]com\//.test(item.url),
      )
    : undefined;
  const shown: InspectorTab = tab === "overview" || git ? tab : "overview";
  return (
    <section
      ref={root}
      tabIndex={-1}
      data-testid="session-inspector"
      aria-label="Inspector"
      className="absolute inset-0 z-30 flex flex-col bg-background outline-none"
    >
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
        <button
          type="button"
          aria-label="Close inspector"
          onClick={close}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface hover:text-on-surface"
        >
          <ChevronLeft size={20} />
        </button>
        <div className="min-w-0 flex-1 px-1">
          <h2 className="text-base font-medium leading-tight">Inspector</h2>
          <p className="truncate text-xs text-muted-foreground">
            {git ? (status.data?.root ?? context.cwd ?? "Git checkout") : "Session details"}
          </p>
        </div>
      </header>
      <div
        role="tablist"
        aria-label="Inspector"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5"
      >
        {TABS.map(({ id, label, Icon }) => {
          const disabled = id !== "overview" && !git;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              data-testid={`session-inspector-tab-${id}`}
              aria-selected={shown === id}
              disabled={disabled}
              onClick={() => home.go({ inspector: id }, { replace: true })}
              className={cn(
                "inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium",
                shown === id
                  ? "bg-surface-highest text-on-surface"
                  : "text-muted-foreground hover:bg-surface hover:text-on-surface",
                disabled && "opacity-40",
              )}
            >
              <Icon size={14} aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown === "overview" && <MobileOverview context={context} home={home} />}
        {shown === "diff" && git && (
          <div className="mobile-inspector-host flex h-full min-h-0 flex-col">
            <GitPanelBody terminal={git} paneId="session-inspector" persistDraft />
          </div>
        )}
        {shown === "pr" &&
          git &&
          (pull ? (
            <div className="mobile-inspector-host flex h-full min-h-0 flex-col">
              <PullReviewPanel
                key={`${pull.repo}:${pull.number}`}
                terminalId={git.id}
                number={pull.number}
                active
              />
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
              <GitPullRequest size={22} className="text-muted-foreground" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">
                {github.isPending ? "Checking pull requests…" : "No open PR for this branch yet."}
              </p>
            </div>
          ))}
        {shown === "files" && git && (
          <div className="flex h-full min-h-0 flex-col">
            <FilePanel terminal={git} paneId="session-inspector" active />
          </div>
        )}
      </div>
    </section>
  );
}
