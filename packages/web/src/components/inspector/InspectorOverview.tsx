import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  SquareTerminal,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Terminal } from "@/api/client";
import { CiStatus, prStateLabel, prStateTone } from "@/components/GithubPullStatus";
import type { SessionContext } from "@/components/SessionHome";
import { Button } from "@/components/ui/button";
import {
  useWorkspaceByPath,
  workspacePortRange,
  workspaceSetupLabel,
} from "@/components/WorkspaceStatus";
import type { SessionHomeNav } from "@/hooks/useSessionHome";
import { fileChangeState } from "@/lib/git-status";
import { pullRequestReviewParams } from "@/lib/session-home";
import { useTerminals } from "@/lib/terminals";
import { cn } from "@/lib/utils";

/** Git status + the branch's GitHub PR, shared by every inspector surface so
 *  the desktop panel and the phone page read (and cache) the same data. */
export function useInspectorGit(git: Terminal | undefined) {
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
  return { status, github, branch, pr };
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

/** Inspector Overview, shared by the desktop panel and the phone page: branch
 *  and changed-files card, the branch's PR with CI state, and session details. */
export function InspectorOverview({
  context,
  home,
}: {
  context: SessionContext;
  home: SessionHomeNav;
}) {
  const git = context.gitTerminal;
  const [, setParams] = useSearchParams();
  const { status, github, branch, pr } = useInspectorGit(git);
  const files = status.data?.files ?? [];
  const staged = files.filter((file) => fileChangeState(file).staged).length;
  const conflicts = files.filter((file) => fileChangeState(file).conflict).length;
  const task = context.session?.task;
  const { data: workspace } = useWorkspaceByPath(context.cwd);
  const ports = workspace ? workspacePortRange(workspace) : null;
  const terminals = useTerminals();
  if (!git)
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <SquareTerminal size={22} className="text-muted-foreground" aria-hidden="true" />
        {terminals.error ? (
          <>
            <p
              role="alert"
              data-testid="session-inspector-terminals-error"
              className="text-sm text-error"
            >
              Could not load terminals: {terminals.error.message}
            </p>
            <Button
              variant="outline"
              data-testid="session-inspector-terminals-retry"
              onClick={() => void terminals.refetch()}
            >
              Retry
            </Button>
          </>
        ) : (
          <>
            <p data-testid="session-inspector-git-empty" className="text-sm text-muted-foreground">
              {terminals.isLoading
                ? "Loading terminals…"
                : "Git activity needs a running terminal in this session's folder."}
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
          </>
        )}
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
      <section
        className="rounded-lg border border-border bg-surface p-3"
        data-testid="session-inspector-pull-request-card"
      >
        <div className="flex items-start gap-2.5">
          <GitPullRequest
            size={17}
            className="mt-0.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            {github.isPending ? (
              <p className="text-sm text-muted-foreground">Checking pull requests…</p>
            ) : github.error ? (
              <>
                <p role="alert" className="text-sm text-error">
                  Could not check pull requests: {github.error.message}
                </p>
                <button
                  type="button"
                  onClick={() => void github.refetch()}
                  className="mt-2 inline-flex min-h-9 items-center rounded-md border border-control-border px-3 text-[13px] hover:bg-surface"
                >
                  Retry
                </button>
              </>
            ) : pr ? (
              <>
                <p
                  data-testid="session-inspector-pull-request"
                  className="text-[13px] font-medium leading-snug"
                >
                  <span className="font-normal text-muted-foreground">{pr.repo} · </span>#
                  {pr.number} {pr.title}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span
                    data-testid="session-inspector-pr-state"
                    className={cn("text-xs", prStateTone(pr.state))}
                  >
                    {prStateLabel(pr.state)}
                  </span>
                  {pr.ci && <CiStatus ci={pr.ci} />}
                </div>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="session-inspector-review-pr"
                    onClick={() =>
                      setParams(
                        (current) =>
                          pullRequestReviewParams(current, {
                            terminalId: git.id,
                            number: pr.number,
                          }),
                        { replace: true },
                      )
                    }
                    className="inline-flex min-h-9 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground"
                  >
                    Review diff
                  </button>
                  <a
                    data-testid="session-inspector-open-pr"
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-control-border px-3 text-[13px] hover:bg-surface"
                  >
                    Open on GitHub
                    <ExternalLink size={12} aria-hidden="true" />
                  </a>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {github.data?.unavailable_reason === "no_remote"
                  ? "This checkout has no GitHub origin remote."
                  : github.data?.auth === "none"
                    ? "GitHub authentication is unavailable on this host. Authenticate gh there or configure a GitHub token."
                    : github.data?.unavailable_reason === "detached_head"
                      ? "Detached HEAD: select a branch to find its pull request."
                      : "No open pull request for this branch."}
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
