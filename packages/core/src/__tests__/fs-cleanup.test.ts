import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeBestEffort } from "../fs-cleanup.js";

test("removes a staging tree and never throws for a missing one", () => {
  const root = mkdtempSync(join(tmpdir(), "orc-fs-cleanup-"));
  try {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "file.txt"), "staged");
    removeTreeBestEffort(root);
    expect(existsSync(root)).toBe(false);
    removeTreeBestEffort(root);
  } finally {
    removeTreeBestEffort(root);
  }
});
