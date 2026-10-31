import { expect, test } from "bun:test";
import { folderBreadcrumbs, joinFolderPath } from "../../src/lib/folder-picker-paths";

test("POSIX breadcrumbs preserve the root and each navigable parent", () => {
  expect(folderBreadcrumbs("/srv/projects/application")).toEqual([
    { label: "/", path: "/" },
    { label: "srv", path: "/srv" },
    { label: "projects", path: "/srv/projects" },
    { label: "application", path: "/srv/projects/application" },
  ]);
  expect(joinFolderPath("/", "application")).toBe("/application");
  expect(folderBreadcrumbs("/")).toEqual([{ label: "/", path: "/" }]);
});

test("Windows drive breadcrumbs remain absolute and child paths retain Windows separators", () => {
  expect(folderBreadcrumbs("C:\\Projects\\application")).toEqual([
    { label: "C:\\", path: "C:\\" },
    { label: "Projects", path: "C:\\Projects" },
    { label: "application", path: "C:\\Projects\\application" },
  ]);
  expect(joinFolderPath("C:\\", "application")).toBe("C:\\application");
  expect(folderBreadcrumbs("C:/Projects/application").map((crumb) => crumb.path)).toEqual([
    "C:\\",
    "C:\\Projects",
    "C:\\Projects\\application",
  ]);
});

test("UNC breadcrumbs keep the server and share together as the navigation root", () => {
  expect(folderBreadcrumbs("\\\\fileserver\\team\\Projects\\application")).toEqual([
    { label: "\\\\fileserver\\team\\", path: "\\\\fileserver\\team\\" },
    { label: "Projects", path: "\\\\fileserver\\team\\Projects" },
    { label: "application", path: "\\\\fileserver\\team\\Projects\\application" },
  ]);
  expect(joinFolderPath("\\\\fileserver\\team\\", "application")).toBe(
    "\\\\fileserver\\team\\application",
  );
  expect(folderBreadcrumbs("\\\\fileserver\\team")).toEqual([
    { label: "\\\\fileserver\\team\\", path: "\\\\fileserver\\team\\" },
  ]);
});
