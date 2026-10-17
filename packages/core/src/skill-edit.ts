import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { prepareSkillFiles, readSkillFile, validateSkillPath } from "./skill-files.js";
import {
  parseFrontmatter,
  readSkill,
  reloadCache,
  type SkillFull,
  validateAuthoredSkillDescription,
} from "./skill-service.js";

export function editSkillFile(
  name: string,
  path: string,
  content: string,
  expectedContent: string,
): SkillFull {
  validateSkillPath(path);
  const skill = readSkill(name) as SkillFull | null;
  if (!skill) throw new NotFoundError("Skill", name);
  if (skill.source !== "user") throw new ValidationError("Built-in skills cannot be edited");
  const root = dirname(skill.path);
  const file = readSkillFile(root, path, false);
  if (file.content !== expectedContent)
    throw new ConflictError("This file changed since it was opened; reopen it before saving");
  if (file.encoding !== "utf8") throw new ValidationError("Binary files cannot be edited as text");
  const entry = path === "SKILL.md" ? content : readSkillFile(root, "SKILL.md", false).content;
  if (parseFrontmatter(entry).frontmatter.name !== name)
    throw new ValidationError("Skill name must stay unchanged");
  if (path === "SKILL.md") validateAuthoredSkillDescription(content, file.content);
  const files = skill.files.map((resource) => {
    const value = readSkillFile(root, resource.name, false);
    return {
      path: resource.name,
      content: resource.name === path ? content : value.content,
      encoding: resource.name === path ? ("utf8" as const) : value.encoding,
    };
  });
  prepareSkillFiles(files, entry);
  writeFileSync(file.path, content, "utf8");
  reloadCache();
  return readSkill(name) as SkillFull;
}
