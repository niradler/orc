---
name: orc-git-flow
description: Git flow for workers in git-managed projects. Branch, commit, push, open PR, report branch/PR in work summary.
---

# Git Flow

You are a **git-aware worker** in a project that uses version control. Follow this flow to manage branches, commits, and pull requests as you execute tasks.

## 1. Detect git availability

Run `git rev-parse --git-dir` in the task scope directory. If it exits non-zero (not a git repo), skip this skill entirely and note "not a git repository" in your work summary.

## 2. Create or check out a branch

**Fresh task:**
- Create a new branch named `task/{taskid}-{3-5-word-kebab-slug-from-title}` based on the current HEAD.
- Example: task `T123` with title "Add user auth flow" becomes `task/T123-add-user-auth-flow`.
- Use `git checkout -b {branch}` to create and check out.

**Resuming after `changes_requested`:**
- The branch already exists. Do not create a new one.
- Find the existing branch with `git branch --list 'task/{taskid}-*'`.
- Check it out with `git checkout {branch}`.
- If the list returns nothing, run `git fetch origin` and retry. If multiple branches match, check out the one whose name most closely matches the task title.

**Worktree:**
- If the task body mentions "worktree", use `git worktree add ../worktrees/task/{taskid} -b {branch}` to create an isolated worktree. Include the worktree path in the work summary comment.
- If you have a preference for a different worktree setup, you may use your own approach.
- Otherwise, skip this step.

## 3. Work and commit incrementally

- Make changes in the branch.
- Commit after each meaningful unit of work.
- Use `git commit -m "{message}"` with clear, actionable descriptions.

## 4. Push before submitting

- Run `git push -u origin {branch}` to push the branch to the remote and set up tracking.
- Do not submit for review until the branch is pushed.

## 5. Open a PR (if gh CLI is available)

- Check if `gh` is available: `gh --version`.

**If gh is available:**
- Create a PR with:
  ```
  gh pr create \
    --title "{task.title}" \
    --body "Task ID: {taskid}

{brief description of what was done}"
  ```
- If resuming: a PR already exists from the previous attempt. The push in step 4 updates it automatically — do not create a new one.
- Copy the PR URL from the output.

**If gh is not available:**
- Skip PR creation.
- Note "no gh CLI available" in your work summary comment.

## 6. Post a work summary comment

Before setting the task status to `review`, post a task comment with this structure:

```
Branch: task/{taskid}-{slug}
PR: https://github.com/.../pull/42
Worktree: /path/to/worktree
What changed: [list of modifications]
Why: [rationale for changes]
Verification: [actual command output showing tests passed, builds succeeded, etc.]
Risks: [any known issues or edge cases]
```

- Include `Branch` and `What changed` / `Why` / `Verification` / `Risks` in all cases.
- Include `PR` line only if a PR was created (skip if gh is unavailable or PR was not made).
- Include `Worktree` line only if you used a worktree.

## 7. Anti-patterns

- **Do not** create a new branch if resuming from `changes_requested`. Reuse the existing one.
- **Do not** skip the push step before submitting for review.
- **Do not** omit the branch name from the work summary comment.
- **Do not** create a new PR if one already exists from a previous attempt.
