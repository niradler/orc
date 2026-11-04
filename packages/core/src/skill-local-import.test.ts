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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  folderSkillSource,
  importLocalAgentSkills,
  type LocalSkillAgent,
  listLocalAgentSkills,
} from "./skill-local-import.js";
import { getUserSkillsDir, readSkill, reloadCache } from "./skill-service.js";

const prefix = `local-import-${process.pid}`;
const fresh = `${prefix}-fresh`;
const shared = `${prefix}-shared`;
const edited = `${prefix}-edited`;
const extra = `${prefix}-extra`;
const renamed = `${prefix}-renamed`;
const similar = `${prefix}-similar`;
const folderSkill = `${prefix}-folder`;
const created = [
  fresh,
  shared,
  edited,
  extra,
  renamed,
  folderSkill,
  `${prefix}-batch1`,
  `${prefix}-batch2`,
];
const longBody =
  "Always run the full test suite before committing. Never dismiss failures as pre-existing; fix them or report them with the exact output.";
const extraSkill = `---
name: ${extra}
description: Extra fields test
model: opus
argument-hint: "[file]"
---
Body
`;
let root: string;
let agents: LocalSkillAgent[];
let claudeDir: string;
let codexDir: string;

function writeSkill(dir: string, name: string, body: string, extra?: Record<string, string>) {
  mkdirSync(join(dir, name, "references"), { recursive: true });
  writeFileSync(
    join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} test\n---\n${body}`,
  );
  for (const [path, content] of Object.entries(extra ?? {})) {
    writeFileSync(join(dir, name, path), content);
  }
}

function listing() {
  return listLocalAgentSkills(agents);
}

function find(agent: string, name: string) {
  const skill = listing()
    .find((entry) => entry.id === agent)
    ?.skills.find((entry) => entry.name === name);
  if (!skill) throw new Error(`Missing ${agent}/${name}`);
  return skill;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orc-local-skills-"));
  claudeDir = join(root, "claude");
  codexDir = join(root, "codex");
  agents = [
    { id: "claude", label: "Claude Code", dir: claudeDir },
    { id: "codex", label: "Codex", dir: codexDir },
    { id: "missing", label: "Missing", dir: join(root, "nope") },
  ];
  writeSkill(claudeDir, fresh, "Fresh body", { "references/guide.md": "Guide" });
  writeSkill(claudeDir, edited, "Edited body");
  writeSkill(codexDir, shared, "Shared body");
  symlinkSync(join(codexDir, shared), join(claudeDir, shared), "junction");
  writeSkill(codexDir, "orc-sdlc", "Not the builtin");
  mkdirSync(join(claudeDir, extra));
  writeFileSync(join(claudeDir, extra, "SKILL.md"), extraSkill);
  mkdirSync(join(codexDir, "broken"));
  writeFileSync(join(codexDir, "broken", "SKILL.md"), "no frontmatter");
  mkdirSync(join(codexDir, "workspace-without-skill"));
});

afterAll(() => {
  for (const name of created) {
    rmSync(join(getUserSkillsDir(), name), { recursive: true, force: true });
    rmSync(join(homedir(), ".orc", "skill-local-imports", `${name}.json`), { force: true });
  }
  rmSync(root, { recursive: true, force: true });
  reloadCache();
});

describe("local agent skill import", () => {
  test("should list only existing agent folders that contain skills", () => {
    const result = listing();
    expect(result.map((agent) => agent.id)).toEqual(["claude", "codex"]);
    expect(result[1]?.skills.map((skill) => skill.name)).not.toContain("workspace-without-skill");
  });

  test("should mark a skill as new, then installed after import with identical content", () => {
    expect(find("claude", fresh).status).toBe("new");
    const result = importLocalAgentSkills([{ agent: "claude", name: fresh }], agents);
    expect(result.imported.map((skill) => skill.name)).toEqual([fresh]);
    expect(existsSync(join(getUserSkillsDir(), fresh, "references", "guide.md"))).toBe(true);
    expect(find("claude", fresh).status).toBe("installed");
  });

  test("should report a name already in ORC with other content as a conflict", () => {
    expect(find("codex", "orc-sdlc").status).toBe("conflict");
    const result = importLocalAgentSkills([{ agent: "codex", name: "orc-sdlc" }], agents);
    expect(result.imported).toEqual([]);
    expect(result.skipped[0]?.reason).toStartWith("conflict");
  });

  test("should mark an unparseable skill invalid", () => {
    const broken = find("codex", "broken");
    expect(broken.status).toBe("invalid");
    expect(broken.error).toContain("frontmatter");
  });

  test("should dedup the same folder exposed by two agents", () => {
    expect(find("claude", shared).also_in).toEqual(["codex"]);
    expect(find("codex", shared).also_in).toEqual(["claude"]);
    const result = importLocalAgentSkills(
      [
        { agent: "codex", name: shared },
        { agent: "claude", name: shared },
      ],
      agents,
    );
    expect(result.imported.map((skill) => skill.name)).toEqual([shared]);
    expect(result.skipped).toEqual([
      { agent: "claude", name: shared, reason: `Same as ${shared}, imported in this batch` },
    ]);
  });

  test("should treat a one-letter edit of an ORC skill as a duplicate, not a new skill", () => {
    writeSkill(codexDir, fresh, "Fresh bdy", { "references/guide.md": "Guide" });
    const typo = find("codex", fresh);
    expect(typo.status).toBe("duplicate");
    expect(typo.match).toMatchObject({ name: fresh, level: "near", where: "orc" });
    const result = importLocalAgentSkills([{ agent: "codex", name: fresh }], agents);
    expect(result.imported).toEqual([]);
    expect(result.skipped[0]?.reason).toBe(`duplicate (near copy of ${fresh})`);
  });

  test("should flag the same content under another name as a duplicate", () => {
    writeSkill(claudeDir, renamed, longBody);
    writeSkill(codexDir, `${renamed}x`, longBody.replace("pre-existing", "preexisting"));
    const result = importLocalAgentSkills([{ agent: "claude", name: renamed }], agents);
    expect(result.imported.map((skill) => skill.name)).toEqual([renamed]);
    const copy = find("codex", `${renamed}x`);
    expect(copy.status).toBe("duplicate");
    expect(copy.match).toMatchObject({ name: renamed, level: "near" });
  });

  test("should import a largely similar skill but warn with the closest match", () => {
    writeSkill(codexDir, similar, `${longBody} Also run the e2e suite before release.`);
    const listed = find("codex", similar);
    expect(listed.status).toBe("new");
    expect(listed.match).toMatchObject({ name: renamed, level: "similar" });
  });

  test("should skip near copies selected together in one batch", () => {
    const one = `${prefix}-batch1`;
    const two = `${prefix}-batch2`;
    writeSkill(claudeDir, one, `${longBody} Batch.`);
    writeSkill(codexDir, two, `${longBody} Btch.`);
    const result = importLocalAgentSkills(
      [
        { agent: "claude", name: one },
        { agent: "codex", name: two },
      ],
      agents,
    );
    expect(result.imported.map((skill) => skill.name)).toEqual([one]);
    expect(result.skipped).toEqual([
      { agent: "codex", name: two, reason: `Same as ${one}, imported in this batch` },
    ]);
  });

  test("should scan any folder recursively for skills", () => {
    const repo = join(root, "repo");
    writeSkill(
      join(repo, ".claude", "skills"),
      folderSkill,
      "Found three levels down, unique text",
    );
    writeSkill(join(repo, "node_modules"), `${prefix}-ignored`, "Never scanned");
    const source = folderSkillSource(repo);
    const [listed] = listLocalAgentSkills([source]);
    expect(listed?.skills.map((skill) => skill.name)).toEqual([folderSkill]);
    expect(listed?.skills[0]?.status).toBe("new");
    const single = listLocalAgentSkills([
      folderSkillSource(join(repo, ".claude", "skills", folderSkill)),
    ]);
    expect(single[0]?.skills.map((skill) => skill.name)).toEqual([folderSkill]);
    const result = importLocalAgentSkills([{ agent: "folder", name: folderSkill }], [source]);
    expect(result.imported.map((skill) => skill.name)).toEqual([folderSkill]);
    expect(() => folderSkillSource("relative/path")).toThrow("absolute");
  });

  test("should compare against effective ORC content when an entry reader is given", () => {
    const effective = `---\nname: ${fresh}\ndescription: ${fresh} test\n---\nFresh body`;
    const reader = (name: string) =>
      name === fresh ? effective.replace("Fresh body", "Rewritten instructions entirely") : null;
    const skill = listLocalAgentSkills(agents, reader)
      .find((entry) => entry.id === "claude")
      ?.skills.find((entry) => entry.name === fresh);
    expect(skill?.status).not.toBe("installed");
  });

  test("should mark a source edited after import as changed, and a locally edited copy as conflict", () => {
    importLocalAgentSkills([{ agent: "claude", name: edited }], agents);
    writeSkill(claudeDir, edited, "Edited body, newer");
    expect(find("claude", edited).status).toBe("changed");
    writeFileSync(join(getUserSkillsDir(), edited, "notes.md"), "local note");
    expect(find("claude", edited).status).toBe("conflict");
  });

  test("should import a skill with fields outside the spec byte-identically and list them", () => {
    const listed = find("claude", extra);
    expect(listed.status).toBe("new");
    expect(listed.extra_fields).toEqual(["model", "argument-hint"]);
    expect(find("claude", fresh).extra_fields).toEqual([]);
    const result = importLocalAgentSkills([{ agent: "claude", name: extra }], agents);
    expect(result.imported.map((skill) => skill.name)).toEqual([extra]);
    expect(readFileSync(join(getUserSkillsDir(), extra, "SKILL.md"), "utf8")).toBe(extraSkill);
    expect(readSkill(extra)).toMatchObject({
      metadata: { model: "opus", "argument-hint": "[file]" },
    });
    expect(find("claude", extra).status).toBe("installed");
  });

  test("should skip unknown skills without failing the batch", () => {
    const result = importLocalAgentSkills([{ agent: "codex", name: "not-there" }], agents);
    expect(result.skipped).toEqual([
      { agent: "codex", name: "not-there", reason: "Skill not found" },
    ]);
  });
});
