import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installEmbeddedSkills } from "./builtin-skills.js";
import { validateAuthoredSkillDescription } from "./skill-service.js";

test("embedded skills preserve supporting bytes and stable baseline across restarts", () => {
  const root = mkdtempSync(join(tmpdir(), "orc-embedded-skills-"));
  const assets = {
    "orc-sample/SKILL.md": Buffer.from(
      "---\nname: orc-sample\ndescription: Sample\n---\nInstructions",
    ).toString("base64"),
    "orc-sample/assets/sample.bin": Buffer.from([0, 255, 12]).toString("base64"),
  };
  const directory = installEmbeddedSkills(assets, root);
  expect(installEmbeddedSkills(assets, root)).toBe(directory);
  expect(readFileSync(join(directory, "orc-sample/assets/sample.bin"))).toEqual(
    Buffer.from([0, 255, 12]),
  );
  expect(() => installEmbeddedSkills({ "../outside": "AA==" }, root)).toThrow("Invalid reference");
  writeFileSync(join(directory, "orc-sample/SKILL.md"), "modified");
  expect(() => installEmbeddedSkills(assets, root)).toThrow("cache was modified");
});

test("built-in skills keep the authored description limit", () => {
  const skillsRoot = join(import.meta.dir, "../../../skills");
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const content = readFileSync(join(skillsRoot, entry.name, "SKILL.md"), "utf8");
    expect(() => validateAuthoredSkillDescription(content), entry.name).not.toThrow();
  }
});
