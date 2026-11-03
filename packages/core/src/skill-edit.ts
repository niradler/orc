import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { prepareSkillFiles, readSkillFile, validateSkillPath } from "./skill-files.js";
import {
  parseFrontmatter,
  readSkill,
  reloadCache,
  type SkillFull,
  validateAuthoredSkillDescription,
} from "./skill-service.js";

function assertNewFile(root: string, path: string): string {
  let target = root;
  for (const part of path.split("/")) {
    target = join(target, part);
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new ValidationError("Skill file symlinks are not allowed");
    if (target !== join(root, path) && !stat.isDirectory())
      throw new ValidationError(`Skill file conflicts with file: ${path}`);
    if (target === join(root, path))
      throw new ConflictError("This file already exists; read it and pass its content to edit");
  }
  return target;
}

/** Edit an existing text file of a user skill, or create one when expectedContent is null. */
export function editSkillFile(
  name: string,
  path: string,
  content: string,
  expectedContent: string | null,
): SkillFull {
  validateSkillPath(path);
  const skill = readSkill(name) as SkillFull | null;
  if (!skill) throw new NotFoundError("Skill", name);
  if (skill.source !== "user") throw new ValidationError("Built-in skills cannot be edited");
  const root = dirname(skill.path);
  let target: string;
  let previous: string | null = null;
  if (expectedContent === null) {
    if (path === "SKILL.md") throw new ConflictError("SKILL.md already exists");
    target = assertNewFile(root, path);
  } else {
    const file = readSkillFile(root, path, false);
    if (file.content !== expectedContent)
      throw new ConflictError("This file changed since it was opened; reopen it before saving");
    if (file.encoding !== "utf8")
      throw new ValidationError("Binary files cannot be edited as text");
    target = file.path;
    previous = file.content;
  }
  const entry = path === "SKILL.md" ? content : readSkillFile(root, "SKILL.md", false).content;
  if (parseFrontmatter(entry).frontmatter.name !== name)
    throw new ValidationError("Skill name must stay unchanged");
  if (path === "SKILL.md") validateAuthoredSkillDescription(content, previous ?? undefined);
  const files = skill.files.map((resource) => {
    const value = readSkillFile(root, resource.name, false);
    return {
      path: resource.name,
      content: resource.name === path ? content : value.content,
      encoding: resource.name === path ? ("utf8" as const) : value.encoding,
    };
  });
  if (previous === null) files.push({ path, content, encoding: "utf8" });
  prepareSkillFiles(files, entry);
  if (previous === null) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
  } else writeFileSync(target, content, "utf8");
  reloadCache();
  return readSkill(name) as SkillFull;
}
