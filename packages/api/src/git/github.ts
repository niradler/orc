import { loadConfig } from "@orc/core/config";
import { OrcError } from "@orc/core/errors";
import { getDb } from "@orc/db/client";
import { z } from "zod";
import { type GitResult, runGit } from "../terminals/session-dir.js";
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
}
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
  head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
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
  try {
    const result = await deps.run(["gh", "auth", "token", "--hostname", "github.com"]);
    if (result.code === 0 && result.stdout.trim())
      return { source: "gh", token: result.stdout.trim() };
  } catch {
    /* CLI not installed; use explicit fallback. */
  }
  if (deps.token) return { source: "token", token: deps.token };
  return { source: "none" };
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

export async function fetchGithubFeed(
  repos: GithubRepo[],
  filter: "relevant" | "assigned" | "branches" | "all",
  deps: GithubDeps,
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
  for (const repository of registry.repos) {
    if (!repository.root) continue;
    const remote = await runGit(["git", "-C", repository.root, "remote", "get-url", "origin"]);
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
    run: runGit,
    fetch,
    token: loadConfig().github.token,
  });
  for (const item of feed.items)
    item.task_ids = tasks
      .filter((task) => task.github_issue === item.url || task.github_pr === item.url)
      .map((task) => task.id);
  feed.errors.push(...registry.errors.map((error) => ({ repo: error.cwd, error: error.error })));
  return feed;
}
