import { describe, expect, spyOn, test } from "bun:test";
import {
  parseSkillRepository,
  readRepositoryFile,
  readTree,
  resolveCommit,
} from "./skill-import.js";
import { mergeSkillFiles } from "./skill-sync.js";

test("should authenticate private commit, tree and binary file requests without following redirects", async () => {
  const commit = "a".repeat(40);
  const requests: string[] = [];
  const respond = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requests.push(url);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-secret");
    expect(init?.redirect).toBe("error");
    expect(new URL(url).origin).toBe("https://api.github.com");
    if (url.includes("/commits/")) return Response.json({ sha: commit });
    if (url.includes("/git/trees/")) return Response.json({ tree: [], truncated: false });
    expect(new Headers(init?.headers).get("Accept")).toBe("application/vnd.github.raw+json");
    return new Response(new Uint8Array([0, 255, 128]));
  };
  const remote = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(respond, { preconnect: fetch.preconnect }),
  );
  try {
    expect(await resolveCommit("acme/private-skills", "HEAD", "private-secret")).toBe(commit);
    expect(await readTree("acme/private-skills", commit, "private-secret")).toEqual([]);
    expect(
      await readRepositoryFile(
        "acme/private-skills",
        commit,
        "skills/demo/a b.bin",
        "private-secret",
      ),
    ).toEqual(Buffer.from([0, 255, 128]));
    expect(requests[2]).toBe(
      `https://api.github.com/repos/acme/private-skills/contents/skills/demo/a%20b.bin?ref=${commit}`,
    );
  } finally {
    remote.mockRestore();
  }
});

test("should retain anonymous public downloads and give safe authentication errors", async () => {
  let status = 200;
  const respond = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    expect(String(input)).toStartWith("https://raw.githubusercontent.com/acme/skills/");
    return new Response("public", { status });
  };
  const remote = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(respond, { preconnect: fetch.preconnect }),
  );
  try {
    expect((await readRepositoryFile("acme/skills", "a".repeat(40), "SKILL.md")).toString()).toBe(
      "public",
    );
    status = 404;
    await expect(readRepositoryFile("acme/skills", "a".repeat(40), "SKILL.md")).rejects.toThrow(
      "sign in with gh on the execution host",
    );
    status = 401;
    await expect(readRepositoryFile("acme/skills", "a".repeat(40), "SKILL.md")).rejects.toThrow(
      "GitHub authentication failed",
    );
  } finally {
    remote.mockRestore();
  }
});

describe("skill repository sources", () => {
  test("should resolve shorthand, GitHub tree and skills.sh URLs", () => {
    expect(parseSkillRepository("vercel-labs/agent-skills")).toEqual({
      repository: "vercel-labs/agent-skills",
      ref: "HEAD",
      path: "",
    });
    expect(parseSkillRepository("https://github.com/acme/skills/tree/main/.agents/skills")).toEqual(
      { repository: "acme/skills", ref: "main", path: ".agents/skills" },
    );
    expect(
      parseSkillRepository("https://github.com/acme/skills/blob/main/skills/demo/SKILL.md").path,
    ).toBe("skills/demo");
    expect(parseSkillRepository("https://skills.sh/acme/skills/demo").skill).toBe("demo");
  });
  test("should reject arbitrary hosts, credentials, schemes and unsafe paths", () => {
    for (const source of [
      "http://github.com/acme/skills",
      "https://localhost/repo",
      "https://user:secret@github.com/acme/skills",
      "https://github.com/acme/skills?token=secret",
      "../skills",
      "acme/..",
      "https://github.com/acme/skills/tree/main/skills/%2e%2e%2fsecret",
      "https://github.com/acme/skills/tree/main/skills/con",
      "https://skills.sh/acme/skills",
    ]) {
      expect(() => parseSkillRepository(source)).toThrow();
    }
  });
});

describe("skill sync merge", () => {
  test("should preserve local edits while applying upstream additions, changes and deletions", () => {
    const merged = mergeSkillFiles(
      { entry: "old", guide: "old", removed: "old" },
      { entry: "local", guide: "old", removed: "old", local: "mine" },
      { entry: "old", guide: "new", added: "new" },
    );
    expect(merged.files).toEqual({ entry: "local", guide: "new", local: "mine", added: "new" });
    expect(merged.conflicts).toEqual([]);
    expect(merged.changed).toEqual(["added", "guide", "removed"]);
  });
  test("should identify edit/edit, edit/delete and independent additions as conflicts", () => {
    const merged = mergeSkillFiles(
      { entry: "old", removed: "old" },
      { entry: "local", removed: "local", added: "local" },
      { entry: "upstream", added: "upstream" },
    );
    expect(merged.conflicts).toEqual(["added", "entry", "removed"]);
    expect(merged.files.entry).toBe("local");
  });
  test("should override only conflicts and retain unrelated local edits", () => {
    const merged = mergeSkillFiles(
      { entry: "old", guide: "old", removed: "old" },
      { entry: "local", guide: "local", removed: "local" },
      { entry: "new", guide: "old" },
      true,
    );
    expect(merged.files).toEqual({ entry: "new", guide: "local" });
    expect(merged.changed).toEqual(["entry", "removed"]);
  });
  test("should accept identical changes and handle prototype-like filenames", () => {
    const files = Object.fromEntries([
      ["__proto__", "safe"],
      ["constructor", "safe"],
    ]);
    expect(mergeSkillFiles({}, files, files).files).toEqual(files);
    expect(mergeSkillFiles({}, {}, files).files).toEqual(files);
    expect(mergeSkillFiles({ entry: "old" }, { entry: "new" }, { entry: "new" }).conflicts).toEqual(
      [],
    );
  });
});
