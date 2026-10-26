import { loadConfig } from "@orc/core/config";
import { OrcError } from "@orc/core/errors";
import { type ExecHost, resolveExecHost } from "@orc/core/exec-host";
import { resolveGithubAuth } from "@orc/core/github-auth";
import { getDb } from "@orc/db/client";
import { z } from "zod";
import { type GitResult, gitRunner } from "../terminals/session-dir.js";
import { gitStatus } from "./panel.js";
import { knownWorktrees } from "./registry.js";

export interface GithubDeps {
  run: (args: string[]) => Promise<GitResult>;
  fetch: typeof fetch;
  token: string | undefined;
}
export interface GithubItem {
  repo: string;
  number: number;
  title: string;
  url: string;
  kind: "issue" | "pr";
  state: string;
  branch: string | null;
  assignees: string[];
  task_ids: string[];
  ci?: GithubCi | null;
}
export const GithubCiSchema = z.object({
  state: z.enum(["success", "failure", "pending", "none"]),
  total: z.number().int().nonnegative(),
  url: z.string().url(),
});
export type GithubCi = z.infer<typeof GithubCiSchema>;
export interface GithubRepo {
  name: string;
  branches: string[];
  linked: string[];
}
export interface GithubFeed {
  auth: "gh" | "token" | "none";
  login: string | null;
  items: GithubItem[];
  errors: { repo: string; error: string }[];
  truncated: boolean;
  unavailable_reason?: "no_remote" | "detached_head";
}

const IssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string().url(),
  state: z.string(),
  assignees: z.array(z.object({ login: z.string() })),
  pull_request: z.unknown().optional(),
});
const PullSchema = IssueSchema.extend({
  body: z.string().nullable().optional(),
  head: z.object({
    ref: z.string(),
    sha: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/i)
      .optional(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
});

export function githubRemote(remote: string): string | null {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
      remote.trim(),
    );
  return match?.[1] ?? null;
}

export async function githubAuth(
  deps: GithubDeps,
): Promise<{ source: "gh" | "token" | "none"; token?: string }> {
  return resolveGithubAuth(deps);
}

async function githubGet(path: string, token: string, deps: GithubDeps): Promise<unknown> {
  const response = await deps.fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new OrcError(
      response.status === 401
        ? "GitHub authentication failed. Refresh gh auth or the configured token."
        : response.status === 403 || response.status === 429
          ? "GitHub rate limit or permission denied. Try again later or check token access."
          : "GitHub request failed. Check repository access.",
      "GITHUB_UNAVAILABLE",
      503,
    );
  return response.json();
}

export async function readGithubCi(
  repo: string,
  sha: string,
  pullUrl: string,
  token: string,
  deps: GithubDeps,
): Promise<GithubCi | null> {
  const checkSchema = z.object({ status: z.string(), conclusion: z.string().nullable() });
  const batchSchema = z.object({
    total_count: z.number().int().nonnegative(),
    check_runs: z.array(checkSchema),
  });
  const statusSchema = z.object({
    state: z.enum(["success", "pending", "failure", "error"]),
    total_count: z.number().int().nonnegative(),
  });
  try {
    const base = `/repos/${repo}/commits/${encodeURIComponent(sha)}`;
    const [first, status] = await Promise.all([
      githubGet(`${base}/check-runs?filter=latest&per_page=100&page=1`, token, deps).then((data) =>
        batchSchema.parse(data),
      ),
      githubGet(`${base}/status`, token, deps).then((data) => statusSchema.parse(data)),
    ]);
    const runs = [...first.check_runs];
    if (first.total_count > 500) return null;
    for (let page = 2; runs.length < first.total_count && page <= 5; page++) {
      const batch = batchSchema.parse(
        await githubGet(`${base}/check-runs?filter=latest&per_page=100&page=${page}`, token, deps),
      );
      if (!batch.check_runs.length) return null;
      runs.push(...batch.check_runs);
    }
    if (runs.length < first.total_count) return null;
    const total = runs.length + status.total_count;
    let state: GithubCi["state"] = total ? "success" : "none";
    const successful = new Set(["success", "neutral", "skipped"]);
    if (
      runs.some((run) => run.status !== "completed" || run.conclusion === null) ||
      (status.total_count > 0 && status.state === "pending")
    )
      state = "pending";
    if (
      runs.some(
        (run) =>
          run.status === "completed" && run.conclusion !== null && !successful.has(run.conclusion),
      ) ||
      (status.total_count > 0 && (status.state === "failure" || status.state === "error"))
    )
      state = "failure";
    return { state, total, url: `${pullUrl}/checks` };
  } catch {
    // Missing permissions or incomplete data must never look like passing CI.
    return null;
  }
}

export async function fetchGithubFeed(
  repos: GithubRepo[],
  filter: "relevant" | "assigned" | "branches" | "all",
  deps: GithubDeps,
  includeCi = false,
): Promise<GithubFeed> {
  const auth = await githubAuth(deps);
  const feed: GithubFeed = {
    auth: auth.source,
    login: null,
    items: [],
    errors: [],
    truncated: false,
  };
  if (!auth.token) return feed;
  const user = z.object({ login: z.string() }).parse(await githubGet("/user", auth.token, deps));
  feed.login = user.login;
  const deadline = Date.now() + 45_000;
  for (const repo of repos.slice(0, 20)) {
    if (Date.now() >= deadline) {
      feed.truncated = true;
      break;
    }
    try {
      const issues: z.infer<typeof IssueSchema>[] = [];
      const pulls: z.infer<typeof PullSchema>[] = [];
      for (let page = 1; page <= 5; page++) {
        if (Date.now() >= deadline) {
          feed.truncated = true;
          break;
        }
        const batch = z
          .array(IssueSchema)
          .parse(
            await githubGet(
              `/repos/${repo.name}/issues?state=open&per_page=100&page=${page}`,
              auth.token,
              deps,
            ),
          );
        issues.push(...batch.filter((issue) => !issue.pull_request));
        if (batch.length < 100) break;
        if (page === 5) feed.truncated = true;
      }
      for (let page = 1; page <= 5; page++) {
        if (Date.now() >= deadline) {
          feed.truncated = true;
          break;
        }
        const batch = z
          .array(PullSchema)
          .parse(
            await githubGet(
              `/repos/${repo.name}/pulls?state=open&per_page=100&page=${page}`,
              auth.token,
              deps,
            ),
          );
        pulls.push(...batch);
        if (batch.length < 100) break;
        if (page === 5) feed.truncated = true;
      }
      for (const issue of issues) {
        const assigned = issue.assignees.some((person) => person.login === user.login);
        const linked = repo.linked.includes(issue.html_url);
        const current = pulls.some(
          (pull) =>
            pull.head.repo?.full_name === repo.name &&
            repo.branches.includes(pull.head.ref) &&
            new RegExp(
              `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+(?:#${issue.number}(?!\\d)|https://github\\.com/${repo.name.replaceAll(".", "\\.")}/issues/${issue.number}(?!\\d))`,
              "i",
            ).test(pull.body ?? ""),
        );
        if (
          (filter === "assigned" && !assigned) ||
          (filter === "branches" && !linked && !current) ||
          (filter === "relevant" && !assigned && !linked && !current)
        )
          continue;
        feed.items.push({
          repo: repo.name,
          number: issue.number,
          title: issue.title,
          url: issue.html_url,
          kind: "issue",
          state: issue.state,
          branch: null,
          assignees: issue.assignees.map((person) => person.login),
          task_ids: [],
        });
      }
      for (const pull of pulls) {
        const assigned = pull.assignees.some((person) => person.login === user.login);
        const current =
          pull.head.repo?.full_name === repo.name && repo.branches.includes(pull.head.ref);
        const linked = repo.linked.includes(pull.html_url);
        if (
          (filter === "assigned" && !assigned) ||
          (filter === "branches" && !current && !linked) ||
          (filter === "relevant" && !assigned && !current && !linked)
        )
          continue;
        const ci =
          includeCi && pull.head.sha
            ? await readGithubCi(repo.name, pull.head.sha, pull.html_url, auth.token, deps)
            : undefined;
        feed.items.push({
          repo: repo.name,
          number: pull.number,
          title: pull.title,
          url: pull.html_url,
          kind: "pr",
          state: pull.state,
          branch: pull.head.ref,
          assignees: pull.assignees.map((person) => person.login),
          task_ids: [],
          ...(ci === undefined ? {} : { ci }),
        });
      }
    } catch (error) {
      feed.errors.push({
        repo: repo.name,
        error: error instanceof OrcError ? error.message : "Could not load GitHub items",
      });
    }
  }
  if (repos.length > 20) feed.truncated = true;
  return feed;
}

export async function githubFeed(
  projectId: string | undefined,
  filter: "relevant" | "assigned" | "branches" | "all",
): Promise<GithubFeed> {
  const registry = await knownWorktrees(projectId);
  const tasks = (await getDb().query.tasks.findMany()).filter(
    (task) => !projectId || task.project_id === projectId,
  );
  const repos = new Map<string, GithubRepo>();
  const hostGit = gitRunner(resolveExecHost());
  for (const repository of registry.repos) {
    if (!repository.root) continue;
    const remote = await hostGit(["git", "-C", repository.root, "remote", "get-url", "origin"]);
    const name = remote.code === 0 ? githubRemote(remote.stdout) : null;
    if (!name) continue;
    const previous = repos.get(name);
    const branches = repository.worktrees.flatMap((tree) => (tree.branch ? [tree.branch] : []));
    repos.set(name, {
      name,
      branches: [...new Set([...(previous?.branches ?? []), ...branches])],
      linked: previous?.linked ?? [],
    });
  }
  for (const task of tasks)
    for (const link of [task.github_issue, task.github_pr]) {
      if (!link) continue;
      const name = githubRemote(link.replace(/\/(?:issues|pull)\/\d+$/, ""));
      if (!name) continue;
      const repo = repos.get(name) ?? { name, branches: [], linked: [] };
      repo.linked.push(link);
      repos.set(name, repo);
    }
  const feed = await fetchGithubFeed([...repos.values()], filter, {
    run: hostGit,
    fetch,
    token: loadConfig().github.token,
  });
  for (const item of feed.items)
    item.task_ids = tasks
      .filter((task) => task.github_issue === item.url || task.github_pr === item.url)
      .map((task) => task.id);
  feed.errors.push(
    ...registry.errors.map((error) => ({
      repo: error.cwd,
      error: error.error,
    })),
  );
  return feed;
}

export async function checkoutGithubFeed(host: ExecHost, cwd: string): Promise<GithubFeed> {
  const status = await gitStatus(host, cwd);
  const remote = await gitRunner(host)(["git", "-C", cwd, "remote", "get-url", "origin"]);
  const name = remote.code === 0 ? githubRemote(remote.stdout) : null;
  if (!name || !status.branch)
    return {
      auth: "none",
      login: null,
      items: [],
      errors: [],
      truncated: false,
      unavailable_reason: !name ? "no_remote" : "detached_head",
    };
  return fetchGithubFeed(
    [{ name, branches: [status.branch], linked: [] }],
    "branches",
    {
      run: gitRunner(host),
      fetch,
      token: loadConfig().github.token,
    },
    true,
  );
}

export interface BranchPull {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  head_sha: string | null;
}
export interface WorktreePulls {
  auth: "gh" | "token" | "none";
  repos: { root: string; repo: string; pulls: Record<string, BranchPull> }[];
  errors: { repo: string; error: string }[];
}
const BranchPullSchema = PullSchema.extend({
  draft: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
});
const MAX_BRANCHES = 40;

// The newest PR whose head is the branch: an open one wins, otherwise the latest closed/merged.
export async function branchPulls(
  repo: string,
  branches: string[],
  token: string,
  deps: GithubDeps,
): Promise<Record<string, BranchPull>> {
  const owner = repo.split("/")[0];
  const found = await Promise.all(
    branches.slice(0, MAX_BRANCHES).map(async (branch) => {
      const pulls = z
        .array(BranchPullSchema)
        .parse(
          await githubGet(
            `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=10`,
            token,
            deps,
          ),
        )
        .filter((pull) => pull.head.ref === branch && pull.head.repo?.full_name === repo);
      const pull = pulls.find((item) => item.state === "open") ?? pulls[0];
      if (!pull) return null;
      return [
        branch,
        {
          number: pull.number,
          title: pull.title,
          url: pull.html_url,
          state: pull.merged_at ? "merged" : pull.state === "open" ? "open" : "closed",
          draft: pull.draft ?? false,
          head_sha: pull.head.sha ?? null,
        },
      ] as const;
    }),
  );
  return Object.fromEntries(found.filter((entry) => entry !== null));
}

async function originRepo(host: ExecHost, root: string): Promise<string | null> {
  const remote = await gitRunner(host)(["git", "-C", root, "remote", "get-url", "origin"]);
  return remote.code === 0 ? githubRemote(remote.stdout) : null;
}

export async function worktreePulls(
  projectId: string | undefined,
  deps: GithubDeps = { run: gitRunner(resolveExecHost()), fetch, token: loadConfig().github.token },
): Promise<WorktreePulls> {
  const auth = await githubAuth(deps);
  const result: WorktreePulls = { auth: auth.source, repos: [], errors: [] };
  if (!auth.token) return result;
  const host = resolveExecHost();
  for (const listing of (await knownWorktrees(projectId)).repos) {
    if (!listing.root) continue;
    const repo = await originRepo(host, listing.root);
    if (!repo) continue;
    const branches = listing.worktrees.flatMap((tree) =>
      tree.branch && !tree.main ? [tree.branch] : [],
    );
    try {
      result.repos.push({
        root: listing.root,
        repo,
        pulls: branches.length ? await branchPulls(repo, branches, auth.token, deps) : {},
      });
    } catch (error) {
      result.errors.push({
        repo,
        error: error instanceof OrcError ? error.message : "Could not load pull requests",
      });
    }
  }
  return result;
}

// Squash and rebase merges never make the branch an ancestor of the default branch, so a
// merged PR counts only while the local branch still points at the commit GitHub merged.
export async function mergedByPull(
  host: ExecHost,
  root: string,
  branch: string,
  head: string | null,
  deps: GithubDeps = { run: gitRunner(host), fetch, token: loadConfig().github.token },
): Promise<boolean> {
  if (!head) return false;
  const repo = await originRepo(host, root);
  const auth = await githubAuth(deps);
  if (!repo || !auth.token) return false;
  try {
    const pull = (await branchPulls(repo, [branch], auth.token, deps))[branch];
    return pull?.state === "merged" && pull.head_sha === head;
  } catch {
    return false;
  }
}
