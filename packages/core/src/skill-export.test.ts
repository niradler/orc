import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportSkills, planSkillExport, resolveExportTarget } from "./skill-export.js";
import { listLocalAgentSkills } from "./skill-local-import.js";
import { createSkill, deleteSkill, getUserSkillsDir, reloadCache } from "./skill-service.js";

const prefix = `skill-export-${process.pid}`;
const alpha = `${prefix}-alpha`;
const beta = `${prefix}-beta`;
const body =
  "Run the release checklist: bump every package version together, build, run local CI and verify the packed tarball before publishing.";
const entry = (name: string, text = body) =>
  `---\nname: ${name}\ndescription: ${name} export test\nmodel: opus\n---\n${text}\n`;
let root: string;
let target: string;
const backups: string[] = [];

function plan(names = [alpha, beta]) {
  return planSkillExport(names, { path: target });
}

function status(name: string, names = [alpha, beta]) {
  return plan(names).skills.find((item) => item.name === name)?.status;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orc-skill-export-"));
  target = join(root, "agent-skills");
  createSkill(alpha, entry(alpha), [
    { path: "references/guide.md", content: "Guide", encoding: "utf8" },
  ]);
  createSkill(beta, entry(beta, "Completely different instructions about deploying the lab."), []);
});

afterAll(() => {
  for (const name of [alpha, beta]) {
    try {
      deleteSkill(name);
    } catch {
      rmSync(join(getUserSkillsDir(), name), { recursive: true, force: true });
    }
  }
  for (const backup of backups) rmSync(join(backup, ".."), { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  reloadCache();
});

describe("skill export", () => {
  test("should plan new skills for an empty target and write them byte-for-byte", () => {
    expect(plan().skills.map((item) => item.status)).toEqual(["new", "new"]);
    const result = exportSkills({ names: [alpha, beta], target: { path: target } });
    expect(result.exported.map((item) => item.name)).toEqual([alpha, beta]);
    expect(readFileSync(join(target, alpha, "SKILL.md"), "utf8")).toBe(entry(alpha));
    expect(readFileSync(join(target, alpha, "references", "guide.md"), "utf8")).toBe("Guide");
    expect(status(alpha)).toBe("identical");
  });

  test("should round-trip: an exported skill lists as installed when imported back", () => {
    const [listing] = listLocalAgentSkills([{ id: "custom", label: "Custom", dir: target }]);
    expect(listing?.skills.find((skill) => skill.name === alpha)?.status).toBe("installed");
  });

  test("should leave identical skills alone", () => {
    const result = exportSkills({ names: [alpha], target: { path: target } });
    expect(result.exported).toEqual([]);
    expect(result.skipped).toEqual([{ name: alpha, reason: "Already identical in the target" }]);
  });

  test("should see a one-letter edit in the target as near and replace it only on request", () => {
    writeFileSync(join(target, alpha, "SKILL.md"), entry(alpha, body.replace("tarball", "tarbal")));
    expect(status(alpha)).toBe("near");
    const kept = exportSkills({ names: [alpha], target: { path: target } });
    expect(kept.exported).toEqual([]);
    expect(kept.skipped[0]?.reason).toContain("near copy");
    const replaced = exportSkills({ names: [alpha], target: { path: target }, overwrite: [alpha] });
    expect(replaced.exported[0]).toMatchObject({ name: alpha, replaced: true });
    const backup = replaced.exported[0]?.backup as string;
    backups.push(backup);
    expect(readFileSync(join(backup, "SKILL.md"), "utf8")).toContain("tarbal ");
    expect(readFileSync(join(target, alpha, "SKILL.md"), "utf8")).toBe(entry(alpha));
  });

  test("should report a different skill with the same name as a conflict", () => {
    writeFileSync(
      join(target, beta, "SKILL.md"),
      entry(beta, "Something else entirely, rewritten."),
    );
    expect(status(beta)).toBe("conflict");
  });

  test("should flag the same skill under another folder name as a duplicate", () => {
    rmSync(join(target, alpha), { recursive: true, force: true });
    const renamed = join(target, `${alpha}-copy`);
    mkdirSync(join(renamed, "references"), { recursive: true });
    writeFileSync(join(renamed, "SKILL.md"), entry(`${alpha}-copy`));
    writeFileSync(join(renamed, "references", "guide.md"), "Guide");
    const item = plan([alpha]).skills[0];
    expect(item?.status).toBe("duplicate");
    expect(item?.match).toMatchObject({ name: `${alpha}-copy`, level: "identical" });
    expect(exportSkills({ names: [alpha], target: { path: target } }).exported).toEqual([]);
    const forced = exportSkills({ names: [alpha], target: { path: target }, overwrite: [alpha] });
    expect(forced.exported[0]).toMatchObject({ name: alpha, replaced: false });
  });

  test("should never replace a symlinked skill folder", () => {
    const linked = join(root, "linked");
    mkdirSync(join(linked, beta), { recursive: true });
    writeFileSync(join(linked, beta, "SKILL.md"), entry(beta, "Linked copy, unrelated text here."));
    const links = join(root, "links");
    mkdirSync(links);
    symlinkSync(join(linked, beta), join(links, beta), "junction");
    const item = planSkillExport([beta], { path: links }).skills[0];
    expect(item?.status).toBe("blocked");
    expect(item?.can_overwrite).toBe(false);
    const result = exportSkills({ names: [beta], target: { path: links }, overwrite: [beta] });
    expect(result.exported).toEqual([]);
    expect(readFileSync(join(linked, beta, "SKILL.md"), "utf8")).toContain("Linked copy");
  });

  test("should export effective instructions from the entry reader", () => {
    const fresh = join(root, "effective");
    const edited = entry(alpha, "Edited in ORC through the instruction history.");
    exportSkills({ names: [alpha], target: { path: fresh } }, (name) =>
      name === alpha ? edited : null,
    );
    expect(readFileSync(join(fresh, alpha, "SKILL.md"), "utf8")).toBe(edited);
  });

  test("should validate targets", () => {
    expect(() => resolveExportTarget({ path: "relative" })).toThrow("absolute");
    expect(() => resolveExportTarget({ path: getUserSkillsDir() })).toThrow("outside ORC");
    expect(() => resolveExportTarget({ agent: "nope" })).toThrow("Unknown agent");
    expect(() =>
      resolveExportTarget({ agent: "x" }, [
        { id: "x", label: "X", dir: join(root, "not-installed", "skills") },
      ]),
    ).toThrow("not installed");
    const missing = planSkillExport([`${prefix}-missing`], { path: target }).skills[0];
    expect(missing).toMatchObject({ status: "blocked", reason: "Skill not found" });
    expect(existsSync(join(target, `${prefix}-missing`))).toBe(false);
  });
});
