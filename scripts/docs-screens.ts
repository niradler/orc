/**
 * Docs images are rare: a screen exists only to show a user how to use something,
 * so every file under docs/public/screens must be displayed by a docs page that
 * references it. Capture specs and ad-hoc shoots otherwise leave orphan images
 * behind. This check runs in ci:pr (the pre-push merge gate) so an unreferenced
 * screen can never be committed again.
 *
 *   bun scripts/docs-screens.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// Corpus: every docs source file (any type) plus the user README, excluding the
// screens directory itself so a file never "references" itself.
function corpus(dir: string, screensDir: string): string {
  let text = "";
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (full === screensDir) continue;
      text += corpus(full, screensDir);
    } else {
      text += `\n${readFileSync(full, "utf8")}`;
    }
  }
  return text;
}

/** Screens under docs/public/screens that no docs page references via `screens/<name>`. */
export function findOrphanScreens(root: string): string[] {
  const screensDir = join(root, "docs", "public", "screens");
  const referenced =
    corpus(join(root, "docs"), screensDir) + readFileSync(join(root, "README.md"), "utf8");
  const image = /\.(png|jpe?g|gif|webp|svg)$/i;
  return walk(screensDir)
    .map((file) => relative(screensDir, file).replaceAll("\\", "/"))
    .filter((name) => image.test(name) && !referenced.includes(`screens/${name}`));
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const orphans = findOrphanScreens(root);
  if (orphans.length > 0) {
    console.error(
      `✗ ${orphans.length} screen(s) under docs/public/screens are not displayed by any docs page.\n` +
        "Docs images are rare — keep only screens a docs page shows to users. Delete these,\n" +
        "or reference them from a docs page (and add the page to the sidebar):\n" +
        orphans.map((name) => `  - docs/public/screens/${name}`).join("\n"),
    );
    process.exit(1);
  }
  console.log("✓ Every docs screen is referenced by a docs page.");
}
