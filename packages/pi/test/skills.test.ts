import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { OrcApiClient, OrcSkill, OrcSkillFile, OrcSkillListItem } from "../src/api.js";
import { readManagedSkillNames, skillFilePath, syncOrcSkills } from "../src/skills.js";

const roots: string[] = [];

function managed(): string {
  const root = mkdtempSync(join(tmpdir(), "porc-skills-"));
  roots.push(root);
  return join(root, "skills");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function item(name: string, projectIds: string[] = []): OrcSkillListItem {
  return { name, description: `${name} skill`, source: "user", project_ids: projectIds };
}

function skill(name: string, files?: OrcSkill["files"]): OrcSkill {
  return {
    name,
    description: `${name} skill`,
    source: "user",
    content: `# ${name}\n`,
    ...(files ? { files } : {}),
  };
}

function fakeApi(options: {
  listed: OrcSkillListItem[];
  skills?: Record<string, OrcSkill>;
  files?: Record<string, OrcSkillFile>;
  onRead?: (name: string, scope: { projectId?: string; global?: boolean }) => void;
}): OrcApiClient {
  return {
    async listSkills() {
      return options.listed;
    },
    async readSkill(name: string, scope: { projectId?: string; global?: boolean }) {
      options.onRead?.(name, scope);
      const value = options.skills?.[name];
      if (!value) throw new Error(`missing skill ${name}`);
      return value;
    },
    async readSkillFile(
      name: string,
      ref: string,
      scope: { projectId?: string; global?: boolean },
    ) {
      options.onRead?.(name, scope);
      const value = options.files?.[`${name}/${ref}`];
      if (!value) throw new Error(`missing file ${name}/${ref}`);
      return value;
    },
  } as unknown as OrcApiClient;
}

describe("skillFilePath", () => {
  const root = resolve("C:/work/skills");

  test("accepts relative paths inside the skill", () => {
    expect(skillFilePath(root, "SKILL.md")).toBe(resolve(root, "SKILL.md"));
    expect(skillFilePath(root, "references/a.md")).toBe(resolve(root, "references", "a.md"));
    expect(skillFilePath(root, "a\\b.md")).toBe(resolve(root, "a", "b.md"));
  });

  test("rejects traversal, absolute paths and empty segments", () => {
    for (const value of [
      "",
      ".",
      "..",
      "../x",
      "a/../../x",
      "/etc/passwd",
      "C:/Windows/x",
      "a//b",
      "a/./b",
      "a\0b",
    ]) {
      expect(skillFilePath(root, value)).toBeUndefined();
    }
  });
});

describe("syncOrcSkills", () => {
  test("writes global and project skills, excludes bundled and other projects", async () => {
    const dir = managed();
    const scopes: Array<{ projectId?: string; global?: boolean }> = [];
    const api = fakeApi({
      listed: [
        item("global-skill"),
        item("project-skill", ["p1"]),
        item("other-skill", ["p2"]),
        item("orc-sdlc"),
      ],
      skills: {
        "global-skill": skill("global-skill"),
        "project-skill": skill("project-skill", [{ name: "ref", path: "references/ref.md" }]),
      },
      files: {
        "project-skill/references/ref.md": {
          name: "project-skill",
          path: "references/ref.md",
          content: "reference",
          encoding: "utf8",
        },
      },
      onRead: (_name, scope) => scopes.push(scope),
    });

    const report = await syncOrcSkills(api, dir, { projectId: "p1" });

    expect(report.written).toEqual(["global-skill", "project-skill"]);
    expect(report.errors).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(readFileSync(join(dir, "global-skill", "SKILL.md"), "utf8")).toBe("# global-skill\n");
    expect(readFileSync(join(dir, "project-skill", "references", "ref.md"), "utf8")).toBe(
      "reference",
    );
    expect(existsSync(join(dir, "other-skill"))).toBe(false);
    expect(existsSync(join(dir, "orc-sdlc"))).toBe(false);
    expect(scopes).toContainEqual({ global: true });
    expect(scopes).toContainEqual({ projectId: "p1" });
  });

  test("prunes stale managed directories but leaves unrelated files alone", async () => {
    const dir = managed();
    mkdirSync(join(dir, "stale"), { recursive: true });
    writeFileSync(join(dir, "stale", "SKILL.md"), "old", "utf8");
    writeFileSync(join(dir, "notes.txt"), "keep", "utf8");
    const api = fakeApi({
      listed: [item("current")],
      skills: { current: skill("current") },
    });

    const report = await syncOrcSkills(api, dir);

    expect(report.removed).toEqual(["stale"]);
    expect(existsSync(join(dir, "stale"))).toBe(false);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });

  test("reports unsafe names, unsafe references, binary files and read failures", async () => {
    const dir = managed();
    const api = fakeApi({
      listed: [item("../escape"), item("bad-refs"), item("binary"), item("broken")],
      skills: {
        "bad-refs": skill("bad-refs", [
          { name: "a", path: "../escape.md" },
          { name: "b", path: "ok.md" },
        ]),
        binary: skill("binary", [{ name: "c", path: "blob.bin" }]),
      },
      files: {
        "bad-refs/ok.md": {
          name: "bad-refs",
          path: "ok.md",
          content: "ok",
          encoding: "utf8",
        },
        "binary/blob.bin": {
          name: "binary",
          path: "blob.bin",
          content: "AA==",
          encoding: "base64",
        },
      },
    });

    const report = await syncOrcSkills(api, dir);

    expect(report.errors.some((value) => value.startsWith("../escape: unsafe skill name"))).toBe(
      true,
    );
    expect(report.errors.some((value) => value.startsWith("broken:"))).toBe(true);
    expect(report.skipped).toContain("bad-refs/../escape.md (unsafe path)");
    expect(report.skipped).toContain("binary/blob.bin (binary)");
    expect(readFileSync(join(dir, "bad-refs", "ok.md"), "utf8")).toBe("ok");
  });

  test("syncs only requested names and explains skipped ones", async () => {
    const dir = managed();
    const api = fakeApi({
      listed: [item("wanted"), item("unwanted"), item("orc-platform")],
      skills: { wanted: skill("wanted") },
    });

    const report = await syncOrcSkills(api, dir, { names: ["wanted", "missing", "orc-platform"] });

    expect(report.written).toEqual(["wanted"]);
    expect(report.skipped).toContain("missing (not available for this project)");
    expect(report.skipped).toContain("orc-platform (bundled with porc)");
    expect(existsSync(join(dir, "unwanted"))).toBe(false);
  });
});

test("readManagedSkillNames lists only safe directories", () => {
  const dir = managed();
  mkdirSync(join(dir, "one"), { recursive: true });
  mkdirSync(join(dir, "bad name"), { recursive: true });
  writeFileSync(join(dir, "file.txt"), "x", "utf8");
  const names = readManagedSkillNames(dir);
  expect(names).toContain("one");
  expect(names).not.toContain("bad name");
  expect(names).not.toContain("file.txt");
  expect(readManagedSkillNames(join(dir, "missing"))).toEqual([]);
});
