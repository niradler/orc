import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { NotFoundError, ValidationError } from "./errors.js";

export type SkillRef = { name: string; path: string };
export type SkillFileInput = {
  path: string;
  content: string;
  encoding?: "utf8" | "base64" | undefined;
};
export type SkillRefContent = SkillRef & { content: string; encoding: "utf8" | "base64" };

export const MAX_SKILL_FILES = 512;
export const MAX_SKILL_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_SKILL_BUNDLE_BYTES = 16 * 1024 * 1024;

export function validateSkillPath(path: string): string {
  const parts = path.split("/");
  if (
    !path ||
    path.length > 1024 ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[\\:<>"|?*]/.test(part) ||
        Array.from(part).some((character) => character.charCodeAt(0) < 32) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
    )
  ) {
    throw new ValidationError(`Invalid reference or skill file path: ${path}`);
  }
  return path;
}

export function listSkillFiles(skillDir: string, entryFile = "SKILL.md"): SkillRef[] {
  const files: SkillRef[] = [];
  function walk(directory: string, prefix: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      validateSkillPath(name);
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, name);
      else if (entry.isFile() && name !== entryFile) {
        files.push({ name, path });
        if (files.length > MAX_SKILL_FILES) throw new ValidationError("Too many skill files");
      }
    }
  }
  walk(skillDir, "");
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkillFile(
  skillDir: string,
  filename: string,
  legacyReferences = true,
): SkillRefContent {
  validateSkillPath(filename);
  let name = filename;
  // Bare filenames from the original API continue to address references/.
  if (
    legacyReferences &&
    filename !== "SKILL.md" &&
    !filename.includes("/") &&
    existsSync(join(skillDir, "references", filename))
  ) {
    name = `references/${filename}`;
  }
  const root = realpathSync(skillDir);
  let path = root;
  for (const part of name.split("/")) {
    path = join(path, part);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new NotFoundError("Skill file", filename);
      }
      throw error;
    }
    if (stat.isSymbolicLink()) throw new ValidationError("Skill file symlinks are not allowed");
  }
  const resolved = realpathSync(path);
  const inside = relative(root, resolved);
  if (inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) {
    throw new ValidationError("Skill file must stay inside the skill directory");
  }
  const stat = lstatSync(resolved);
  if (!stat.isFile()) throw new NotFoundError("Skill file", filename);
  if (stat.size > MAX_SKILL_FILE_BYTES) throw new ValidationError("Skill file exceeds 8 MiB");
  const bytes = readFileSync(resolved);
  const encoded = encodeSkillFile(bytes);
  return { name: filename, path: resolved, ...encoded };
}

export function encodeSkillFile(bytes: Buffer): Pick<SkillRefContent, "content" | "encoding"> {
  try {
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!content.includes("\0")) return { content, encoding: "utf8" };
  } catch {
    // Non-UTF-8 assets need lossless transport over JSON.
  }
  return { content: bytes.toString("base64"), encoding: "base64" };
}

export function prepareSkillFiles(
  files: SkillFileInput[],
  entryContent: string,
  entryFile = "SKILL.md",
): Array<{ path: string; bytes: Buffer }> {
  if (files.length > MAX_SKILL_FILES) throw new ValidationError("Too many skill files");
  const paths = new Set([entryFile.toLowerCase()]);
  let total = Buffer.byteLength(entryContent);
  if (total > MAX_SKILL_FILE_BYTES) throw new ValidationError("SKILL.md exceeds 8 MiB");
  const prepared = files.map((file) => {
    const path = validateSkillPath(file.path);
    const key = path.toLowerCase();
    if (paths.has(key)) throw new ValidationError(`Duplicate skill file: ${path}`);
    paths.add(key);
    if (file.encoding && file.encoding !== "utf8" && file.encoding !== "base64") {
      throw new ValidationError(`Invalid encoding for skill file: ${path}`);
    }
    if (
      file.encoding === "base64" &&
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)
    ) {
      throw new ValidationError(`Invalid base64 for skill file: ${path}`);
    }
    const bytes = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
    if (bytes.length > MAX_SKILL_FILE_BYTES) throw new ValidationError("Skill file exceeds 8 MiB");
    total += bytes.length;
    return { path, bytes };
  });
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      if (paths.has(parts.slice(0, index).join("/"))) {
        throw new ValidationError(`Skill file conflicts with directory: ${path}`);
      }
    }
  }
  if (total > MAX_SKILL_BUNDLE_BYTES) throw new ValidationError("Skill bundle exceeds 16 MiB");
  return prepared;
}
