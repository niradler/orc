import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listSkillReferenceFiles } from "../skill-refs.js";

const TMP = join(import.meta.dirname, ".tmp-skill-refs-test");

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, "skills/with-refs"), { recursive: true });
  mkdirSync(join(TMP, "skills/no-refs"), { recursive: true });
  mkdirSync(join(TMP, "skills/with-subdir/scripts"), { recursive: true });

  writeFileSync(join(TMP, "skills/with-refs/SKILL.md"), "main content");
  writeFileSync(join(TMP, "skills/with-refs/reference.md"), "# API Docs");
  writeFileSync(join(TMP, "skills/with-refs/examples.md"), "# Examples");

  writeFileSync(join(TMP, "skills/no-refs/SKILL.md"), "just me");

  writeFileSync(join(TMP, "skills/with-subdir/SKILL.md"), "content");
  writeFileSync(join(TMP, "skills/with-subdir/notes.md"), "Some notes");
  writeFileSync(join(TMP, "skills/with-subdir/scripts/run.sh"), "#!/bin/bash");
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("listSkillReferenceFiles", () => {
  test("returns file names excluding SKILL.md", () => {
    const files = listSkillReferenceFiles("skills/with-refs", TMP);
    expect(files).toContain("reference.md");
    expect(files).toContain("examples.md");
    expect(files).not.toContain("SKILL.md");
  });

  test("returns empty array when no sibling files", () => {
    expect(listSkillReferenceFiles("skills/no-refs", TMP)).toEqual([]);
  });

  test("skips subdirectories", () => {
    const files = listSkillReferenceFiles("skills/with-subdir", TMP);
    expect(files).toContain("notes.md");
    expect(files).not.toContain("scripts");
  });

  test("returns empty for non-existent directory", () => {
    expect(listSkillReferenceFiles("skills/ghost", TMP)).toEqual([]);
  });
});
