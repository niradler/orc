import { expect, test } from "bun:test";
import { projectForFolder } from "../project-path.js";

const projects = [
  { id: "root", scope: "/srv/orc" },
  { id: "nested", scope: "/srv/orc/packages/web" },
  { id: "sibling", scope: "/srv/other" },
];

test("picks the most specific project folder", () => {
  expect(projectForFolder("/srv/orc/packages/web/src", projects)?.id).toBe("nested");
  expect(projectForFolder("/srv/orc/packages/api", projects)?.id).toBe("root");
  expect(projectForFolder("/srv/orc", projects)?.id).toBe("root");
});

test("does not match sibling prefixes or missing folders", () => {
  expect(projectForFolder("/srv/other-repo", projects)).toBeUndefined();
  expect(projectForFolder("/srv/other", projects)?.id).toBe("sibling");
  expect(projectForFolder("", projects)).toBeUndefined();
  expect(projectForFolder(null, projects)).toBeUndefined();
});

test("normalizes trailing separators and Windows path casing", () => {
  expect(projectForFolder("/srv/orc/packages/web/", projects)?.id).toBe("nested");
  const windows = [{ id: "win", scope: "C:\\Projects\\Orc" }];
  expect(projectForFolder("c:/projects/orc/src", windows)?.id).toBe("win");
  expect(projectForFolder("//?/C:/Projects/Orc/src", windows)?.id).toBe("win");
  expect(projectForFolder("C:/Projects/Orchid", windows)).toBeUndefined();
});
