import { describe, expect, test } from "bun:test";
import type { GithubDeps } from "../git/github.js";
import {
  PullCommentInputSchema,
  patchContainsLine,
  postPullComment,
  readPullReview,
} from "../git/pull-review.js";

const head = "a".repeat(40);
const patch = "@@ -1,2 +1,2 @@\n same\n-old\n+new\n";
const pull = {
  number: 94,
  title: "Review changes",
  body: "PR description",
  state: "open",
  html_url: "https://github.com/owner/repo/pull/94",
  user: { login: "author" },
  head: { sha: head, ref: "feature", repo: { full_name: "owner/repo" } },
  base: { ref: "main" },
  changed_files: 1,
};
const comment = {
  id: 10,
  body: "Review this",
  user: { login: "reviewer" },
  html_url: "https://github.com/owner/repo/pull/94#discussion_r10",
  created_at: "2026-10-23T00:00:00Z",
  path: "src/a.ts",
  line: 2,
  side: "RIGHT",
};

function fixture(
  options: {
    moved?: boolean;
    state?: string;
    branch?: string;
    many?: boolean;
    denied?: boolean;
    large?: boolean;
  } = {},
) {
  const writes: { url: string; body: unknown }[] = [];
  let reads = 0;
  const deps: GithubDeps = {
    token: undefined,
    run: async () => ({ code: 0, stdout: "test-gh-token", stderr: "" }),
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://api.github.com");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-gh-token");
      if (options.denied) return new Response("sensitive upstream detail", { status: 403 });
      if (init?.method === "POST") {
        writes.push({ url: url.pathname, body: JSON.parse(String(init.body)) });
        return Response.json(comment);
      }
      if (url.pathname.endsWith("/files")) {
        const file = {
          filename: "src/a.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: options.large ? "x".repeat(200_001) : patch,
        };
        if (options.large)
          return Response.json(
            Array.from({ length: 6 }, (_, i) => ({ ...file, filename: `large-${i}.ts` })),
          );
        return Response.json(
          options.many
            ? Array.from({ length: 100 }, (_, i) => ({
                ...file,
                filename: `${url.searchParams.get("page")}/${i}.ts`,
              }))
            : [file],
        );
      }
      if (url.pathname.endsWith("/reviews"))
        return Response.json([
          {
            id: 20,
            body: null,
            user: null,
            html_url: pull.html_url,
            state: "APPROVED",
            submitted_at: "2026-10-22T00:00:00Z",
          },
        ]);
      if (url.pathname.includes("/issues/"))
        return Response.json([
          { ...comment, id: 30, path: undefined, line: undefined, body: "General discussion" },
        ]);
      if (url.pathname.endsWith("/comments"))
        return Response.json([comment, { ...comment, id: 11, in_reply_to_id: 10, body: "Reply" }]);
      reads++;
      return Response.json({
        ...pull,
        state: options.state ?? pull.state,
        head: {
          ...pull.head,
          ref: options.branch ?? "feature",
          sha: options.moved && reads > 1 ? "b".repeat(40) : head,
        },
      });
    }) as typeof fetch,
  };
  return { deps, writes };
}

describe("checkout pull request review", () => {
  test("should read PR changes, description, discussions and review threads without writing", async () => {
    const { deps, writes } = fixture();
    const result = await readPullReview("owner/repo", "feature", 94, deps);
    expect(result.head).toBe(head);
    expect(result.files[0]?.patch).toBe(patch);
    expect(result.comments).toHaveLength(2);
    expect(result.discussion[0]?.body).toBe("General discussion");
    expect(result.reviews[0]).toMatchObject({
      body: "",
      state: "APPROVED",
      created_at: "2026-10-22T00:00:00Z",
    });
    expect(result.truncated).toBe(false);
    expect(writes).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("test-gh-token");
  });
  test("should reject a snapshot whose head changes during pagination", async () => {
    await expect(
      readPullReview("owner/repo", "feature", 94, fixture({ moved: true }).deps),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  test("should reject a PR from another branch before reading its patches or posting", async () => {
    const { deps, writes } = fixture({ branch: "other" });
    await expect(
      postPullComment(
        "owner/repo",
        "feature",
        94,
        { kind: "discussion", head, body: "hello" },
        deps,
      ),
    ).rejects.toThrow("current branch");
    expect(writes).toEqual([]);
  });
  test("should fail without authentication and hide upstream permission response details", async () => {
    const { deps } = fixture();
    await expect(
      readPullReview("owner/repo", "feature", 94, {
        ...deps,
        run: async () => ({ code: 1, stdout: "", stderr: "" }),
      }),
    ).rejects.toThrow("authentication");
    await expect(
      readPullReview("owner/repo", "feature", 94, fixture({ denied: true }).deps),
    ).rejects.toThrow("repository permissions");
  });
  test("should send a general comment only to this checkout PR", async () => {
    const { deps, writes } = fixture();
    await postPullComment(
      "owner/repo",
      "feature",
      94,
      { kind: "discussion", head, body: "  Clear review\nwith details  " },
      deps,
    );
    expect(writes).toEqual([
      { url: "/repos/owner/repo/issues/94/comments", body: { body: "Clear review\nwith details" } },
    ]);
  });
  test("should anchor inline comments to the reviewed commit, file, side and actual diff line", async () => {
    const { deps, writes } = fixture();
    await postPullComment(
      "owner/repo",
      "feature",
      94,
      { kind: "inline", head, body: "Check new code", path: "src/a.ts", line: 2, side: "RIGHT" },
      deps,
    );
    expect(writes[0]).toEqual({
      url: "/repos/owner/repo/pulls/94/comments",
      body: { body: "Check new code", commit_id: head, path: "src/a.ts", line: 2, side: "RIGHT" },
    });
    await expect(
      postPullComment(
        "owner/repo",
        "feature",
        94,
        { kind: "inline", head, body: "bad", path: "../private", line: 2, side: "RIGHT" },
        deps,
      ),
    ).rejects.toThrow("current diff");
    await expect(
      postPullComment(
        "owner/repo",
        "feature",
        94,
        { kind: "inline", head, body: "bad", path: "src/a.ts", line: 300, side: "RIGHT" },
        deps,
      ),
    ).rejects.toThrow("current diff");
    expect(writes).toHaveLength(1);
  });
  test("should refuse stale heads and closed PRs without posting", async () => {
    const { deps, writes } = fixture();
    await expect(
      postPullComment(
        "owner/repo",
        "feature",
        94,
        { kind: "discussion", head: "b".repeat(40), body: "draft" },
        deps,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    const closed = fixture({ state: "closed" });
    await expect(
      postPullComment(
        "owner/repo",
        "feature",
        94,
        { kind: "discussion", head, body: "draft" },
        closed.deps,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect([...writes, ...closed.writes]).toEqual([]);
  });
  test("should keep replies in their PR and normalize a reply to the root thread", async () => {
    const { deps, writes } = fixture();
    await postPullComment(
      "owner/repo",
      "feature",
      94,
      { kind: "reply", head, body: "Agreed", comment_id: 11 },
      deps,
    );
    expect(writes).toEqual([
      { url: "/repos/owner/repo/pulls/94/comments/10/replies", body: { body: "Agreed" } },
    ]);
    await expect(
      postPullComment(
        "owner/repo",
        "feature",
        94,
        { kind: "reply", head, body: "bad", comment_id: 999 },
        deps,
      ),
    ).rejects.toThrow("not in the loaded PR");
    expect(writes).toHaveLength(1);
  });
  test("should bound pagination and mark partial results", async () => {
    const result = await readPullReview("owner/repo", "feature", 94, fixture({ many: true }).deps);
    expect(result.files).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });
  test("should reject blank, oversized, unsupported and unvalidated comment payloads", () => {
    for (const body of ["", "   ", "a".repeat(20_001)])
      expect(PullCommentInputSchema.safeParse({ kind: "discussion", body, head }).success).toBe(
        false,
      );
    expect(PullCommentInputSchema.safeParse({ kind: "approve", body: "ok", head }).success).toBe(
      false,
    );
    expect(
      PullCommentInputSchema.safeParse({
        kind: "discussion",
        body: "ok",
        head,
        repo: "other/private",
      }).success,
    ).toBe(false);
  });
  test("should recognize context and removed lines on the correct diff side", () => {
    expect(patchContainsLine(patch, 1, "LEFT")).toBe(true);
    expect(patchContainsLine(patch, 2, "LEFT")).toBe(true);
    expect(patchContainsLine("@@ -1,1 +0,0 @@\n-gone\n", 1, "RIGHT")).toBe(false);
    expect(patchContainsLine(patch, 3, "RIGHT")).toBe(false);
  });
  test("should bound patch payloads and expose truncation rather than presenting complete diffs", async () => {
    const result = await readPullReview("owner/repo", "feature", 94, fixture({ large: true }).deps);
    expect(result.files).toHaveLength(6);
    expect(
      result.files.reduce((sum, file) => sum + (file.patch?.length ?? 0), 0),
    ).toBeLessThanOrEqual(1_000_000);
    expect(result.files.every((file) => (file.patch?.length ?? 0) <= 200_000)).toBe(true);
    expect(result.files.some((file) => file.patch_truncated)).toBe(true);
  });
  test("should reject path-shaped repositories and invalid PR ids before credential access", async () => {
    const { deps, writes } = fixture();
    await expect(readPullReview("owner/..", "feature", 94, deps)).rejects.toThrow(
      "Invalid GitHub repository",
    );
    await expect(readPullReview("owner/repo", "feature", -1, deps)).rejects.toThrow(
      "Invalid pull request",
    );
    expect(writes).toEqual([]);
  });
});
