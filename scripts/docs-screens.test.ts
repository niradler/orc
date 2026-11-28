import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findOrphanScreens } from "./docs-screens.js";

test("should flag screens no docs page displays and keep referenced ones", () => {
  const root = mkdtempSync(join(tmpdir(), "orc-docs-screens-"));
  try {
    const screens = join(root, "docs", "public", "screens");
    mkdirSync(join(screens, "nested"), { recursive: true });
    mkdirSync(join(root, "docs", "docs"), { recursive: true });
    writeFileSync(join(screens, "shown.png"), "x");
    writeFileSync(join(screens, "orphan.png"), "x");
    writeFileSync(join(screens, "nested", "deep-orphan.png"), "x");
    writeFileSync(join(root, "docs", "docs", "guide.md"), "![how to use](/screens/shown.png)\n");
    writeFileSync(join(root, "README.md"), "# Orc\n");
    expect(findOrphanScreens(root).sort()).toEqual(["nested/deep-orphan.png", "orphan.png"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("should not count a reference that lives only inside the screens directory", () => {
  const root = mkdtempSync(join(tmpdir(), "orc-docs-screens-"));
  try {
    const screens = join(root, "docs", "public", "screens");
    mkdirSync(screens, { recursive: true });
    writeFileSync(join(screens, "lonely.png"), "x");
    writeFileSync(join(screens, "notes.md"), "see /screens/lonely.png\n");
    writeFileSync(join(root, "README.md"), "# Orc\n");
    expect(findOrphanScreens(root)).toEqual(["lonely.png"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
