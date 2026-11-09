import { describe, expect, test } from "bun:test";
import { displayPath, pathLabel } from "../display-path.js";

describe("cross-platform display paths", () => {
  test.each([
    ["C:\\Projects\\orc", "C:/Projects/orc", "orc"],
    ["\\\\?\\C:\\Projects\\orc\\", "C:/Projects/orc", "orc"],
    ["C:/Projects\\orc/", "C:/Projects/orc", "orc"],
    ["\\\\server\\share\\orc\\", "//server/share/orc", "orc"],
    ["\\\\?\\UNC\\server\\share\\orc", "//server/share/orc", "orc"],
    ["//?/C:/Projects/orc", "C:/Projects/orc", "orc"],
    ["/home/nir/orc/", "/home/nir/orc", "orc"],
    ["/home/nir/a\\b", "/home/nir/a\\b", "a\\b"],
    ["file:///C:/Projects/my%20repo/", "C:/Projects/my repo", "my repo"],
    ["file:///home/nir/my%20repo", "/home/nir/my repo", "my repo"],
    ["file://server/share/orc", "//server/share/orc", "orc"],
    ["C:\\", "C:/", "C:/"],
    ["/", "/", "/"],
    ["relative\\folder\\orc", "relative/folder/orc", "orc"],
    ["~/src/orc", "~/src/orc", "orc"],
    ["file://%", "file://%", "file://%"],
    ["", "", ""],
  ])("should display %s independently of the server OS", (input, displayed, label) => {
    expect(displayPath(input)).toBe(displayed);
    expect(pathLabel(input)).toBe(label);
  });
  test("should share the same parsing for compact multi-part labels", () => {
    expect(pathLabel("\\\\?\\C:\\Projects\\orc", 2)).toBe("Projects/orc");
    expect(pathLabel("file://server/share/folder/orc", 2)).toBe("folder/orc");
    expect(pathLabel(null)).toBe("");
    expect(pathLabel(undefined)).toBe("");
  });
});
