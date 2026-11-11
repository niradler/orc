import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import type { OrcProjectRoot } from "../src/api.js";
import {
  findProjectByName,
  matchProjectRoot,
  projectNameFor,
  readProjectChoices,
  savedProjectChoice,
  saveProjectChoice,
  shouldAskForProject,
} from "../src/project.js";

function root(projectId: string, projectName: string, path: string): OrcProjectRoot {
  return {
    project_id: projectId,
    project_name: projectName,
    root: path,
    folders: [],
  };
}

const workspace = resolve("C:/work");
const nested = join(workspace, "apps", "web");
const projects = [
  root("root", "workspace", workspace),
  root("web", "web-app", nested),
  root("other", "other", resolve("C:/other")),
];

describe("matchProjectRoot", () => {
  test("picks the deepest project containing the directory", () => {
    expect(matchProjectRoot(projects, join(nested, "src"))?.projectId).toBe("web");
    expect(matchProjectRoot(projects, workspace)?.projectId).toBe("root");
  });

  test("matches case-insensitively and ignores empty roots", () => {
    const mixed = [...projects, root("empty", "empty", "  ")];
    expect(matchProjectRoot(mixed, nested.toUpperCase())?.projectId).toBe("web");
  });

  test("does not match a sibling with a shared prefix", () => {
    expect(matchProjectRoot(projects, resolve("C:/work-other/app"))).toBeUndefined();
    expect(matchProjectRoot(projects, resolve("C:/elsewhere"))).toBeUndefined();
  });
});

describe("findProjectByName", () => {
  test("resolves exact names case-insensitively after trimming", () => {
    expect(findProjectByName(projects, "  WEB-APP ")?.projectId).toBe("web");
  });

  test("returns undefined for unknown names", () => {
    expect(findProjectByName(projects, "nope")).toBeUndefined();
  });
});

describe("project choices", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const file = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "porc-choices-"));
    dirs.push(dir);
    return join(dir, "agent", "porc-projects.json");
  };

  test("a saved choice applies to nested folders until cleared", () => {
    const path = file();
    const repo = resolve("C:/work/repo");
    saveProjectChoice(path, repo, { project: "repo" });
    saveProjectChoice(path, join(repo, "scratch"), { global: true });

    expect(savedProjectChoice(path, join(repo, "src", "lib"))).toEqual({
      choice: { project: "repo" },
      path: repo.toLowerCase(),
    });
    expect(savedProjectChoice(path, join(repo, "scratch", "x"))?.choice).toEqual({ global: true });
    expect(savedProjectChoice(path, resolve("C:/elsewhere"))).toBeUndefined();

    saveProjectChoice(path, repo, null);
    expect(savedProjectChoice(path, join(repo, "src"))).toBeUndefined();
  });

  test("ignores malformed choice files and entries", () => {
    const path = file();
    expect(readProjectChoices(path)).toEqual({});
    saveProjectChoice(path, resolve("C:/a"), { project: "a" });
    writeFileSync(path, JSON.stringify({ "c:\\b": { nope: 1 }, "c:\\a": { project: "a" } }));
    expect(Object.keys(readProjectChoices(path))).toEqual(["c:\\a"]);
    writeFileSync(path, "{not json");
    expect(readProjectChoices(path)).toEqual({});
  });

  test("projectNameFor makes a valid ORC project name", () => {
    expect(projectNameFor(resolve("C:/work/My App (2)"))).toBe("My-App-2");
    expect(projectNameFor(resolve("C:/work/api_v2"))).toBe("api_v2");
  });

  test("never asks in the home directory or a filesystem root", () => {
    const home = resolve("C:/Users/me");
    expect(shouldAskForProject(home, home)).toBe(false);
    expect(shouldAskForProject(parse(home).root, home)).toBe(false);
    expect(shouldAskForProject(join(home, "code", "app"), home)).toBe(true);
  });
});
