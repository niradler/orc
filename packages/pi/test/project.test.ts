import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import type { OrcProjectRoot } from "../src/api.js";
import { findProjectByName, matchProjectRoot } from "../src/project.js";

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
