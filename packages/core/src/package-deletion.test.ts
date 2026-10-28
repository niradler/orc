import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPackage,
  deletePackage,
  listPackages,
  packageRevision,
  readPackage,
} from "./package-service.js";
import { reloadCache } from "./skill-service.js";

const original = process.env.ORC_PACKAGES_DIR;
const root = mkdtempSync(join(tmpdir(), "orc-package-deletion-"));
const directory = join(root, "packages");
beforeAll(() => {
  process.env.ORC_PACKAGES_DIR = directory;
});
afterAll(() => {
  if (original === undefined) delete process.env.ORC_PACKAGES_DIR;
  else process.env.ORC_PACKAGES_DIR = original;
  reloadCache();
});

for (const format of ["apm", "agent-plugin"] as const) {
  test(`deleting ${format} removes only the catalog entry and retains its files`, () => {
    const name = `delete-${format}`;
    const content =
      format === "apm"
        ? `name: ${name}\nversion: 1.0.0\n`
        : JSON.stringify({
            $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            name,
            description: "Deletion fixture",
          });
    const current = createPackage(
      name,
      content,
      [{ path: "asset.bin", content: "AP+A", encoding: "base64" }],
      format,
    );
    const installed = join(root, "project-install", name);
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "asset.bin"), "project copy");
    const revision = packageRevision(current);
    deletePackage(name, revision);
    expect(readPackage(name)).toBeNull();
    expect(listPackages().packages.some((pkg) => pkg.name === name)).toBe(false);
    expect(readFileSync(join(installed, "asset.bin"), "utf8")).toBe("project copy");
    const archive = readdirSync(join(root, "package-revisions")).find((entry) =>
      entry.startsWith(`${name}-deleted-`),
    );
    expect(archive).toBeDefined();
    if (!archive) throw new Error("Deleted package archive was not retained");
    expect(
      readFileSync(join(root, "package-revisions", archive, current.manifestFile), "utf8"),
    ).toBe(content);
    expect(readFileSync(join(root, "package-revisions", archive, "asset.bin"))).toEqual(
      Buffer.from("AP+A", "base64"),
    );
    expect(() => deletePackage(name, revision)).toThrow("not found");
  });
}

describe("package deletion boundaries", () => {
  test("a stale revision cannot remove a package changed after confirmation", () => {
    const current = createPackage("stale-delete", "name: stale-delete\nversion: 1.0.0\n", []);
    const revision = packageRevision(current);
    writeFileSync(join(current.path, "apm.yml"), "name: stale-delete\nversion: 2.0.0\n");
    expect(() => deletePackage(current.name, revision)).toThrow("changed");
    expect(readPackage(current.name)?.manifest.version).toBe("2.0.0");
  });
  test("rejects traversal, symlinked catalog roots and symlinked archive roots", () => {
    const current = createPackage("symlink-delete", "name: symlink-delete\nversion: 1.0.0\n", []);
    const revision = packageRevision(current);
    for (const name of ["../stale-delete", "nested/stale-delete", "..\\stale-delete"])
      expect(() => deletePackage(name, revision)).toThrow();
    const linked = join(root, "linked-catalog");
    symlinkSync(directory, linked, process.platform === "win32" ? "junction" : "dir");
    process.env.ORC_PACKAGES_DIR = linked;
    try {
      expect(() => deletePackage(current.name, revision)).toThrow("symlink");
    } finally {
      process.env.ORC_PACKAGES_DIR = directory;
    }
    const alternate = join(root, "alternate");
    process.env.ORC_PACKAGES_DIR = join(alternate, "packages");
    try {
      const other = createPackage("archive-link", "name: archive-link\nversion: 1.0.0\n", []);
      symlinkSync(
        root,
        join(alternate, "package-revisions"),
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(() => deletePackage(other.name, packageRevision(other))).toThrow("symlink");
      expect(existsSync(other.path)).toBe(true);
    } finally {
      process.env.ORC_PACKAGES_DIR = directory;
    }
  });
});
