import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import Ajv from "ajv/dist/2020.js";
import { parseAgent } from "./agent-service.js";
import { apmSchemaInput } from "./apm-mcp.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { parseMarkdownFrontmatter } from "./markdown-frontmatter.js";
import { getPackagesDir } from "./package-paths.js";
import { parsePluginManifest, validatePluginMcp } from "./plugin-service.js";
import type { ApmManifest, PackageFormat, PackageFull, PackageMeta } from "./primitive-types.js";

import amendmentSchema from "./schemas/apm/manifest-v0.1.41.schema.json";
import manifestSchema from "./schemas/apm/manifest-v0.1.schema.json";
import {
  listSkillFiles,
  prepareSkillFiles,
  readSkillFile,
  type SkillFileInput,
  validateSkillPath,
} from "./skill-files.js";
import { parseFrontmatter, readSkill, reloadCache, type SkillFull } from "./skill-service.js";

export { getPackagesDir } from "./package-paths.js";
export type {
  ApmManifest,
  PackageFull,
  PackageMeta,
} from "./primitive-types.js";

const validator = new Ajv({ allErrors: true, strict: false });
const manifestValidators = new Map([
  [manifestSchema.$id, validator.compile(manifestSchema)],
  [amendmentSchema.$id, validator.compile(amendmentSchema)],
]);

export function parseApmManifest(content: string): ApmManifest {
  let manifest: unknown;
  try {
    manifest = Bun.YAML.parse(content);
  } catch (error) {
    throw new ValidationError(`Invalid apm.yml YAML: ${(error as Error).message}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new ValidationError("apm.yml must be a mapping");
  const fields = manifest as Record<string, unknown>;
  const schema = fields.$schema ?? manifestSchema.$id;
  const validate = typeof schema === "string" ? manifestValidators.get(schema) : undefined;
  if (!validate) throw new ValidationError(`Unsupported OpenAPM schema: ${String(schema)}`);
  if (!validate(apmSchemaInput(fields)))
    throw new ValidationError(`Invalid apm.yml: ${validator.errorsText(validate.errors)}`);
  return manifest as ApmManifest;
}

export function validateInstruction(content: string): {
  fields: Record<string, unknown>;
  body: string;
} {
  const parsed = parseMarkdownFrontmatter(content);
  if (typeof parsed.fields.description !== "string" || !parsed.fields.description.trim())
    throw new ValidationError("Instruction description is required");
  const applyTo = parsed.fields.applyTo;
  if (
    applyTo !== undefined &&
    typeof applyTo !== "string" &&
    (!Array.isArray(applyTo) ||
      applyTo.some((value) => value !== null && typeof value !== "string"))
  ) {
    throw new ValidationError(
      "Instruction applyTo must be a glob string or YAML array of glob strings",
    );
  }
  return parsed;
}

export function validatePackagePrimitives(
  files: Array<{ path: string; bytes: Buffer }>,
  packageName: string,
): void {
  for (const file of files) {
    const primitive =
      file.path.endsWith("/SKILL.md") ||
      file.path === "SKILL.md" ||
      file.path.endsWith(".agent.md") ||
      file.path.endsWith(".instructions.md");
    let content = "";
    if (primitive) {
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
      } catch {
        throw new ValidationError(`Primitive must be UTF-8 Markdown: ${file.path}`);
      }
    }
    if (file.path.endsWith("/SKILL.md") || file.path === "SKILL.md") {
      const { frontmatter } = parseFrontmatter(content);
      const expected = file.path === "SKILL.md" ? packageName : basename(dirname(file.path));
      if (frontmatter.name !== expected)
        throw new ValidationError(`Skill directory must match name: ${file.path}`);
    } else if (file.path.endsWith(".agent.md")) parseAgent(content, file.path);
    else if (file.path.endsWith(".instructions.md")) validateInstruction(content);
  }
}

export function listPackages(): {
  packages: PackageMeta[];
  broken: Array<{ path: string; error: string }>;
} {
  const directory = getPackagesDir();
  const packages: PackageMeta[] = [];
  const broken: Array<{ path: string; error: string }> = [];
  if (!existsSync(directory)) return { packages, broken };
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    try {
      const format =
        existsSync(join(path, "plugin.json")) && !existsSync(join(path, "apm.yml"))
          ? "agent-plugin"
          : "apm";
      const manifestFile = format === "apm" ? "apm.yml" : "plugin.json";
      const content = readSkillFile(path, manifestFile, false).content;
      const parsed =
        format === "apm"
          ? { manifest: parseApmManifest(content), warnings: [] }
          : parsePluginManifest(content);
      const { manifest, warnings } = parsed;
      if (format === "apm") {
        for (const file of listSkillFiles(path, manifestFile)) {
          if (!/(SKILL\.md|\.agent\.md|\.instructions\.md)$/.test(file.name)) continue;
          try {
            const data = readSkillFile(path, file.name, false);
            validatePackagePrimitives(
              [{ path: file.name, bytes: Buffer.from(data.content, data.encoding) }],
              entry.name,
            );
          } catch (error) {
            warnings.push(
              `${file.name}: ${error instanceof ValidationError ? error.message : "Invalid primitive"}`,
            );
          }
        }
      }
      if (format === "agent-plugin") {
        if (existsSync(join(path, "mcp.json"))) {
          try {
            const file = readSkillFile(path, "mcp.json", false);
            validatePluginMcp([
              { path: "mcp.json", content: file.content, encoding: file.encoding },
            ]);
          } catch (error) {
            warnings.push(
              `mcp.json: ${error instanceof ValidationError ? error.message : "Invalid MCP configuration"}`,
            );
          }
        }
      }
      packages.push({
        name: entry.name,
        version: manifest.version ?? "",
        description: manifest.description ?? "",
        path,
        manifest,
        format,
        manifestFile,
        warnings,
      });
    } catch (error) {
      broken.push({ path, error: (error as Error).message });
    }
  }
  return {
    packages: packages.sort((a, b) => a.name.localeCompare(b.name)),
    broken,
  };
}

export function readPackage(name: string): PackageFull | null {
  validateSkillPath(name);
  if (name.includes("/")) throw new ValidationError("Package name must be a directory name");
  const meta = listPackages().packages.find((entry) => entry.name === name);
  if (!meta) return null;
  return {
    ...meta,
    content: readSkillFile(meta.path, meta.manifestFile, false).content,
    files: listSkillFiles(meta.path, meta.manifestFile),
  };
}

export function readPackageFile(name: string, path: string) {
  const pkg = readPackage(name);
  if (!pkg) throw new NotFoundError("Package", name);
  return readSkillFile(pkg.path, path, false);
}

export function createPackage(
  name: string,
  content: string,
  files: SkillFileInput[],
  format: PackageFormat = "apm",
  imported = false,
): PackageFull {
  validateSkillPath(name);
  if (name.includes("/")) throw new ValidationError("Package name must be a directory name");
  const manifestFile = format === "apm" ? "apm.yml" : "plugin.json";
  const { manifest, warnings } =
    format === "apm"
      ? { manifest: parseApmManifest(content), warnings: [] }
      : parsePluginManifest(content);
  if (manifest.name !== name)
    throw new ValidationError(`Package directory must match ${manifestFile} name`);
  const prepared = prepareSkillFiles(files, content, manifestFile);
  if (format === "apm" && !imported) validatePackagePrimitives(prepared, name);
  if (format === "agent-plugin" && !imported) validatePluginMcp(files);
  // Plugins isolate invalid components. Import preserves their original files;
  // discovery/activation reports or skips invalid components independently.
  if (format === "agent-plugin" && prepared.some((file) => file.path === "apm.yml"))
    throw new ValidationError("Choose one package format; import the other manifest separately");
  const root = getPackagesDir();
  if (existsSync(root) && lstatSync(root).isSymbolicLink())
    throw new ValidationError("Package directory cannot be a symlink");
  const path = join(root, name);
  if (existsSync(path)) throw new ConflictError(`Package already exists: ${name}`);
  mkdirSync(root, { recursive: true });
  mkdirSync(path);
  writeFileSync(join(path, manifestFile), content, {
    encoding: "utf8",
    flag: "wx",
  });
  for (const file of prepared) {
    const destination = join(path, file.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, file.bytes, { flag: "wx" });
  }
  reloadCache();
  return {
    name,
    version: manifest.version ?? "",
    description: manifest.description ?? "",
    path,
    manifest,
    format,
    manifestFile,
    warnings,
    content,
    files: listSkillFiles(path, manifestFile),
  };
}

/** Copy selected skills, including binary resources, without changing the originals. */
export function packageSkillFiles(names: string[], format: PackageFormat): SkillFileInput[] {
  if (names.length > 32 || new Set(names).size !== names.length)
    throw new ValidationError("Select up to 32 unique skills");
  reloadCache();
  const files: SkillFileInput[] = [];
  const included = new Set<string>();
  for (const name of names) {
    const skill = readSkill(name) as SkillFull | null;
    if (!skill) throw new NotFoundError("Skill", name);
    const directory = dirname(skill.path);
    const entry = readSkillFile(directory, "SKILL.md", false);
    const { frontmatter } = parseFrontmatter(entry.content);
    if (included.has(frontmatter.name))
      throw new ValidationError(`Duplicate skill name: ${frontmatter.name}`);
    included.add(frontmatter.name);
    const prefix = `${format === "apm" ? ".apm/skills" : "skills"}/${frontmatter.name}`;
    files.push({ path: `${prefix}/SKILL.md`, content: entry.content, encoding: entry.encoding });
    for (const ref of skill.files) {
      const file = readSkillFile(directory, ref.name, false);
      files.push({ path: `${prefix}/${ref.name}`, content: file.content, encoding: file.encoding });
    }
  }
  return files;
}

export function packageRevision(pkg: PackageFull): string {
  const hash = createHash("sha256").update(pkg.content);
  for (const file of pkg.files) {
    const data = readSkillFile(pkg.path, file.name, false);
    hash.update(`\0${file.name}\0${data.encoding}\0${data.content}`);
  }
  return hash.digest("hex");
}

/** Validate a complete replacement before publishing; preserve the previous version. */
export function updatePackage(
  name: string,
  input: {
    content: string;
    files: SkillFileInput[];
    expectedRevision: string;
    skills?: string[] | undefined;
  },
): PackageFull {
  const current = readPackage(name);
  if (!current) throw new NotFoundError("Package", name);
  if (lstatSync(getPackagesDir()).isSymbolicLink() || lstatSync(current.path).isSymbolicLink())
    throw new ValidationError("Package directory cannot be a symlink");
  if (packageRevision(current) !== input.expectedRevision)
    throw new ConflictError("Package changed since it was opened. Reopen it before saving.");
  const manifest =
    current.format === "apm"
      ? parseApmManifest(input.content)
      : parsePluginManifest(input.content).manifest;
  if (manifest.name !== name)
    throw new ValidationError("Package name cannot change while editing; create a copy instead");
  const files = [...input.files, ...packageSkillFiles(input.skills ?? [], current.format)];
  const prepared = prepareSkillFiles(files, input.content, current.manifestFile);
  if (current.format === "apm") validatePackagePrimitives(prepared, name);
  if (current.format === "agent-plugin") validatePluginMcp(files);
  if (current.format === "agent-plugin" && prepared.some((file) => file.path === "apm.yml"))
    throw new ValidationError("Agent Plugins cannot contain an APM manifest");
  const archiveRoot = join(dirname(getPackagesDir()), "package-revisions");
  if (existsSync(archiveRoot) && lstatSync(archiveRoot).isSymbolicLink())
    throw new ValidationError("Package revision directory cannot be a symlink");
  mkdirSync(archiveRoot, { recursive: true });
  const stage = join(archiveRoot, `${name}-${crypto.randomUUID()}`);
  mkdirSync(stage);
  writeFileSync(join(stage, current.manifestFile), input.content, { flag: "wx" });
  for (const file of prepared) {
    const path = join(stage, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.bytes, { flag: "wx" });
  }
  if (packageRevision(current) !== input.expectedRevision)
    throw new ConflictError("Package changed while saving. Reopen it before saving.");
  const backup = join(archiveRoot, `${name}-previous-${crypto.randomUUID()}`);
  renameSync(current.path, backup);
  try {
    renameSync(stage, current.path);
  } catch (error) {
    renameSync(backup, current.path);
    throw error;
  }
  reloadCache();
  return readPackage(name) as PackageFull;
}

export function packageInstructionsForAgent(agentPath: string): string {
  const packages = listPackages().packages;
  const pkg = packages.find(
    (entry) => agentPath.startsWith(`${entry.path}\\`) || agentPath.startsWith(`${entry.path}/`),
  );
  if (!pkg) return "";
  const instructions = listSkillFiles(pkg.path, "apm.yml").filter(
    (file) => file.name.startsWith(".apm/instructions/") && file.name.endsWith(".instructions.md"),
  );
  return instructions
    .map((file) => {
      const parsed = validateInstruction(readFileSync(file.path, "utf8"));
      if (parsed.fields.applyTo === undefined)
        return `## Package instruction: ${file.name}\n${parsed.body}`;
      return `Scoped package instruction: ${file.path}\nApply only to files matching applyTo ${JSON.stringify(parsed.fields.applyTo)}. Read the instruction when working on matching files.`;
    })
    .join("\n\n");
}
