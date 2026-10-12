import { describe, expect, test } from "bun:test";
import { parseSkillRepository } from "./skill-import.js";
import { mergeSkillFiles } from "./skill-sync.js";

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
