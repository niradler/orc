import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const sourceRoot = resolve(packageRoot, "../../skills");
const targetRoot = join(packageRoot, "skills");
const skills = ["orc-platform", "orc-sdlc"];
const check = process.argv.includes("--check");

function files(root: string, at = root): string[] {
  return readdirSync(at).flatMap((name) => {
    const full = join(at, name);
    return statSync(full).isDirectory() ? files(root, full) : [relative(root, full)];
  });
}

if (!check) {
  rmSync(targetRoot, { recursive: true, force: true });
  for (const skill of skills) {
    for (const file of files(join(sourceRoot, skill))) {
      const target = join(targetRoot, skill, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(sourceRoot, skill, file), target);
    }
  }
  console.log(`Synced ${skills.join(", ")} into ${relative(process.cwd(), targetRoot)}`);
} else {
  const drift: string[] = [];
  for (const skill of skills) {
    const source = join(sourceRoot, skill);
    const target = join(targetRoot, skill);
    const expected = files(source);
    const actual = files(target);
    for (const file of expected) {
      if (!actual.includes(file)) drift.push(`missing ${skill}/${file}`);
      else if (!readFileSync(join(source, file)).equals(readFileSync(join(target, file))))
        drift.push(`changed ${skill}/${file}`);
    }
    for (const file of actual) if (!expected.includes(file)) drift.push(`extra ${skill}/${file}`);
  }
  if (drift.length) {
    console.error(
      `Bundled skills are out of date. Run "bun run sync:skills":\n${drift.join("\n")}`,
    );
    process.exit(1);
  }
  console.log("Bundled skills match the repository skill sources.");
}
