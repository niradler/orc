import { z } from "@hono/zod-openapi";
import { loadConfig } from "@orc/core/config";
import { OrcError, ValidationError } from "@orc/core/errors";
import type { ExecHost } from "@orc/core/exec-host";
import { gitRunner } from "../terminals/session-dir.js";
import { type GithubDeps, githubAuth, githubRemote } from "./github.js";
import { gitStatus } from "./panel.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const user = z.object({ login: z.string() }).nullable();
const commentSchema = z.object({
  id: z.number().int().positive(),
  body: z
    .string()
    .nullable()
    .transform((value) => value ?? ""),
  user,
  html_url: z.string().url(),
  created_at: z.string(),
  path: z.string().optional(),
  line: z.number().int().nullable().optional(),
  original_line: z.number().int().nullable().optional(),
  side: z.string().optional(),
  in_reply_to_id: z.number().int().optional(),
  state: z.string().optional(),
});
const fileSchema = z.object({
  filename: z.string(),
  previous_filename: z.string().optional(),
  status: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  patch: z.string().optional(),
});
const reviewSchema = commentSchema
  .omit({ created_at: true })
  .extend({
    submitted_at: z.string().nullable(),
  })
  .transform(({ submitted_at, ...review }) => ({ ...review, created_at: submitted_at ?? "" }));
const pullSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  html_url: z.string().url(),
  user,
  head: z.object({ sha, ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ ref: z.string() }),
  changed_files: z.number().int().nonnegative(),
});

export const PullCommentInputSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("discussion"),
        head: sha,
        body: z.string().trim().min(1).max(20_000),
      })
      .strict(),
    z
      .object({
        kind: z.literal("inline"),
        head: sha,
        body: z.string().trim().min(1).max(20_000),
        path: z.string().min(1).max(4096),
        line: z.number().int().positive().max(10_000_000),
        side: z.enum(["LEFT", "RIGHT"]),
      })
      .strict(),
    z
      .object({
        kind: z.literal("reply"),
        head: sha,
        body: z.string().trim().min(1).max(20_000),
        comment_id: z.number().int().positive(),
      })
      .strict(),
  ])
  .openapi("PullCommentInput");
export type PullCommentInput = z.infer<typeof PullCommentInputSchema>;
export const PullReviewSchema = z
  .object({
    repo: z.string(),
    number: z.number().int(),
    title: z.string(),
    body: z.string(),
    state: z.string(),
    url: z.string().url(),
    author: z.string(),
    head: sha,
    branch: z.string(),
    base: z.string(),
    changed_files: z.number().int(),
    files: z.array(fileSchema.extend({ patch_truncated: z.boolean() })),
    comments: z.array(commentSchema),
    discussion: z.array(commentSchema),
    reviews: z.array(commentSchema),
    truncated: z.boolean(),
  })
  .openapi("PullReview");
export type PullReview = z.infer<typeof PullReviewSchema>;

class PullGithub {
  readonly signal = AbortSignal.timeout(45_000);
  constructor(
    readonly deps: GithubDeps,
    readonly token: string,
  ) {}

  async request(path: string, body?: unknown): Promise<unknown> {
    const response = await this.deps.fetch(`https://api.github.com${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) {
      if (response.status === 422)
        throw new ValidationError(
          "GitHub rejected this comment. Refresh the PR and check the selected line.",
        );
      throw new OrcError(
        "GitHub could not complete this request. Check authentication, repository permissions and rate limits.",
        "GITHUB_UNAVAILABLE",
        503,
      );
    }
    const text = await response.text();
    if (text.length > 12_000_000)
      throw new OrcError(
        "GitHub response is too large. Open this PR in GitHub.",
        "GITHUB_LIMIT",
        413,
      );
    return JSON.parse(text) as unknown;
  }

  async list<T>(path: string, schema: z.ZodType<T>): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    for (let page = 1; page <= 5; page++) {
      const batch = z.array(schema).parse(await this.request(`${path}?per_page=100&page=${page}`));
      items.push(...batch);
      if (batch.length < 100) return { items, truncated: false };
    }
    return { items, truncated: true };
  }
}

async function pullContext(repo: string, branch: string, number: number, deps: GithubDeps) {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
    repo.split("/").some((part) => part === "." || part === "..")
  )
    throw new ValidationError("Invalid GitHub repository");
  if (!Number.isSafeInteger(number) || number < 1)
    throw new ValidationError("Invalid pull request");
  const auth = await githubAuth(deps);
  if (!auth.token)
    throw new OrcError(
      "GitHub authentication is unavailable on this terminal's host.",
      "GITHUB_AUTH",
      503,
    );
  const github = new PullGithub(deps, auth.token);
  const path = `/repos/${repo}/pulls/${number}`;
  const pull = pullSchema.parse(await github.request(path));
  if (
    pull.number !== number ||
    pull.head.ref !== branch ||
    pull.head.repo?.full_name.toLowerCase() !== repo.toLowerCase()
  )
    throw new ValidationError(
      "This PR does not belong to the terminal's current branch. Refresh the checkout.",
    );
  return { github, path, pull };
}

export async function readPullReview(
  repo: string,
  branch: string,
  number: number,
  deps: GithubDeps,
): Promise<PullReview> {
  const { github, path, pull } = await pullContext(repo, branch, number, deps);
  const [files, comments, discussion, reviews] = await Promise.all([
    github.list(`${path}/files`, fileSchema),
    github.list(`${path}/comments`, commentSchema),
    github.list(`/repos/${repo}/issues/${number}/comments`, commentSchema),
    github.list(`${path}/reviews`, reviewSchema),
  ]);
  // Verify the snapshot after paginated reads; never attach a new head to old patches.
  const latest = pullSchema.parse(await github.request(path));
  if (latest.head.sha !== pull.head.sha)
    throw new OrcError(
      "The PR changed while loading. Refresh to review its latest commit.",
      "PR_CHANGED",
      409,
    );
  let remaining = 1_000_000;
  const patches = files.items.map((file) => {
    const patch = file.patch?.slice(0, Math.min(remaining, 200_000));
    remaining -= patch?.length ?? 0;
    return {
      ...file,
      ...(patch === undefined ? {} : { patch }),
      patch_truncated: file.patch !== undefined && patch?.length !== file.patch.length,
    };
  });
  return PullReviewSchema.parse({
    repo,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? "",
    state: pull.state,
    url: `https://github.com/${repo}/pull/${number}`,
    author: pull.user?.login ?? "Deleted user",
    head: pull.head.sha,
    branch: pull.head.ref,
    base: pull.base.ref,
    changed_files: pull.changed_files,
    files: patches,
    comments: comments.items,
    discussion: discussion.items,
    reviews: reviews.items,
    truncated:
      files.truncated ||
      comments.truncated ||
      discussion.truncated ||
      reviews.truncated ||
      files.items.length < pull.changed_files,
  });
}

export function patchContainsLine(patch: string, line: number, side: "LEFT" | "RIGHT"): boolean {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !/^[ +-]/.test(text)) continue;
    if (side === "LEFT" && text[0] !== "+" && oldLine === line) return true;
    if (side === "RIGHT" && text[0] !== "-" && newLine === line) return true;
    if (text[0] !== "+") oldLine++;
    if (text[0] !== "-") newLine++;
  }
  return false;
}

export async function postPullComment(
  repo: string,
  branch: string,
  number: number,
  input: PullCommentInput,
  deps: GithubDeps,
): Promise<void> {
  const body = PullCommentInputSchema.parse(input);
  const { github, path, pull } = await pullContext(repo, branch, number, deps);
  if (pull.head.sha !== body.head)
    throw new OrcError(
      "The PR has new commits. Refresh before sending; your draft is retained.",
      "PR_CHANGED",
      409,
    );
  if (pull.state !== "open")
    throw new OrcError(
      "This PR is closed. Open GitHub to continue the discussion.",
      "PR_CLOSED",
      409,
    );
  if (body.kind === "discussion") {
    await github.request(`/repos/${repo}/issues/${number}/comments`, { body: body.body });
    return;
  }
  if (body.kind === "reply") {
    const comments = await github.list(`${path}/comments`, commentSchema);
    const comment = comments.items.find((item) => item.id === body.comment_id);
    if (!comment) throw new ValidationError("This review thread is not in the loaded PR comments.");
    await github.request(`${path}/comments/${comment.in_reply_to_id ?? comment.id}/replies`, {
      body: body.body,
    });
    return;
  }
  const files = await github.list(`${path}/files`, fileSchema);
  const file = files.items.find((item) => item.filename === body.path);
  if (!file?.patch || !patchContainsLine(file.patch, body.line, body.side))
    throw new ValidationError("Select a line in this PR's current diff.");
  await github.request(`${path}/comments`, {
    body: body.body,
    commit_id: pull.head.sha,
    path: body.path,
    line: body.line,
    side: body.side,
  });
}

export async function terminalPullContext(
  host: ExecHost,
  cwd: string,
): Promise<{ repo: string; branch: string; deps: GithubDeps }> {
  const run = gitRunner(host);
  const [status, remote] = await Promise.all([
    gitStatus(host, cwd),
    run(["git", "-C", cwd, "remote", "get-url", "origin"]),
  ]);
  const repo = remote.code === 0 ? githubRemote(remote.stdout) : null;
  if (!repo || !status.branch)
    throw new ValidationError("PR review needs a GitHub origin and a checked-out branch.");
  return { repo, branch: status.branch, deps: { run, fetch, token: loadConfig().github.token } };
}
