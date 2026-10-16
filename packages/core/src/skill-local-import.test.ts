import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  importLocalAgentSkills,
  type LocalSkillAgent,
  listLocalAgentSkills,
} from "./skill-local-import.js";
import { getUserSkillsDir, reloadCache } from "./skill-service.js";

const prefix = `local-import-${process.pid}`;
const fresh = `${prefix}-fresh`;
const shared = `${prefix}-shared`;
const edited = `${prefix}-edited`;
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
  writeSkill(codexDir, "orc-coder", "Not the builtin");
  mkdirSync(join(codexDir, "broken"));
  writeFileSync(join(codexDir, "broken", "SKILL.md"), "no frontmatter");
  mkdirSync(join(codexDir, "workspace-without-skill"));
});

afterAll(() => {
  for (const name of [fresh, shared, edited]) {
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
    expect(find("codex", "orc-coder").status).toBe("conflict");
    const result = importLocalAgentSkills([{ agent: "codex", name: "orc-coder" }], agents);
    expect(result.imported).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("conflict");
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
      { agent: "claude", name: shared, reason: "Already imported in this batch" },
    ]);
  });

  test("should mark a source edited after import as changed, and a locally edited copy as conflict", () => {
    importLocalAgentSkills([{ agent: "claude", name: edited }], agents);
    writeSkill(claudeDir, edited, "Edited body, newer");
    expect(find("claude", edited).status).toBe("changed");
    writeFileSync(join(getUserSkillsDir(), edited, "notes.md"), "local note");
    expect(find("claude", edited).status).toBe("conflict");
  });

  test("should skip unknown skills without failing the batch", () => {
    const result = importLocalAgentSkills([{ agent: "codex", name: "not-there" }], agents);
    expect(result.skipped).toEqual([
      { agent: "codex", name: "not-there", reason: "Skill not found" },
    ]);
  });
});
