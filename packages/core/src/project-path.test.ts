import { expect, test } from "bun:test";
import { projectForFolder } from "./project-path";

test("project folders match Windows spellings and nested scopes without matching siblings", () => {
  const projects = [
    { id: "orc", scope: "C:\\Projects\\orc" },
    { id: "nested", scope: "C:/Projects/orc/packages/web" },
  ];
  expect(projectForFolder("\\\\?\\C:\\projects\\ORC\\.orc\\worktrees\\review", projects)?.id).toBe(
    "orc",
  );
  expect(projectForFolder("c:/Projects/ORC/packages/web/src", projects)?.id).toBe("nested");
  expect(projectForFolder("C:/Projects/orchestra", projects)).toBeUndefined();
  expect(projectForFolder(null, projects)).toBeUndefined();
  expect(projectForFolder("c:/Projects/orc", [{ id: "drive", scope: "C:/" }])?.id).toBe("drive");
});

test("POSIX project scopes retain case and UNC folders normalize Windows case", () => {
  const projects = [
    { id: "unix", scope: "/home/nir/orc" },
    { id: "share", scope: "\\\\server\\Projects\\orc" },
  ];
  expect(projectForFolder("/home/nir/orc/src", projects)?.id).toBe("unix");
  expect(projectForFolder("/home/nir/ORC/src", projects)).toBeUndefined();
  expect(projectForFolder("\\\\?\\UNC\\SERVER\\projects\\ORC\\src", projects)?.id).toBe("share");
});
