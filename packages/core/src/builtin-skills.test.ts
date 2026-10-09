import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installEmbeddedSkills } from "./builtin-skills.js";

test("embedded skills preserve supporting bytes and stable baseline across restarts", () => {
  const root = mkdtempSync(join(tmpdir(), "orc-embedded-skills-"));
  const assets = {
    "orc-wiki/SKILL.md": Buffer.from(
      "---\nname: orc-wiki\ndescription: Wiki\n---\nInstructions",
    ).toString("base64"),
    "orc-wiki/assets/sample.bin": Buffer.from([0, 255, 12]).toString("base64"),
  };
  const directory = installEmbeddedSkills(assets, root);
  expect(installEmbeddedSkills(assets, root)).toBe(directory);
  expect(readFileSync(join(directory, "orc-wiki/assets/sample.bin"))).toEqual(
    Buffer.from([0, 255, 12]),
  );
  expect(() => installEmbeddedSkills({ "../outside": "AA==" }, root)).toThrow("Invalid reference");
  writeFileSync(join(directory, "orc-wiki/SKILL.md"), "modified");
  expect(() => installEmbeddedSkills(assets, root)).toThrow("cache was modified");
});
