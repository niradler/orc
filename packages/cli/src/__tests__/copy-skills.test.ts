import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltinSkills } from "../../copy-skills.js";

const root = mkdtempSync(join(tmpdir(), "orc-copy-skills-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("repeated packaging excludes retired skills and references while preserving their original bytes", () => {
  const source = join(root, "source");
  const destination = join(root, "dist", "skills");
  mkdirSync(join(source, "orc-platform", "references"), { recursive: true });
  writeFileSync(join(source, "orc-platform", "SKILL.md"), "current entry");
  writeFileSync(join(source, "orc-platform", "references", "current.md"), "current ref");
  mkdirSync(join(destination, "orc-platform", "references"), { recursive: true });
  mkdirSync(join(destination, "orc-retired"));
  writeFileSync(join(destination, "orc-retired", "SKILL.md"), "retired entry");
  writeFileSync(join(destination, "orc-platform", "references", "retired.md"), "retired ref");

  copyBuiltinSkills(source, destination);
  copyBuiltinSkills(source, destination);

  expect(readdirSync(destination)).toEqual(["orc-platform"]);
  expect(readdirSync(join(destination, "orc-platform", "references"))).toEqual(["current.md"]);
  expect(readFileSync(join(destination, "orc-platform", "SKILL.md"), "utf8")).toBe("current entry");
  const archives = readdirSync(join(root, "dist")).filter((name) =>
    name.startsWith(".retired-skills-"),
  );
  expect(archives).toHaveLength(1);
  const archive = join(root, "dist", archives[0] as string);
  expect(readFileSync(join(archive, "orc-retired", "SKILL.md"), "utf8")).toBe("retired entry");
  expect(readFileSync(join(archive, "orc-platform", "references", "retired.md"), "utf8")).toBe(
    "retired ref",
  );
});
