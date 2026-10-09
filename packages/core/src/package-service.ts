import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import Ajv from "ajv/dist/2020.js";
import { parseAgent } from "./agent-service.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { parseMarkdownFrontmatter } from "./markdown-frontmatter.js";
import { getPackagesDir } from "./package-paths.js";
import { parsePluginManifest } from "./plugin-service.js";
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
import { parseFrontmatter, reloadCache } from "./skill-service.js";

export { getPackagesDir } from "./package-paths.js";
export type { ApmManifest, PackageFull, PackageMeta } from "./primitive-types.js";

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
  if (!validate(manifest))
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
  return { packages: packages.sort((a, b) => a.name.localeCompare(b.name)), broken };
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
  if (format === "apm") validatePackagePrimitives(prepared, name);
  // Plugins isolate invalid components. Import preserves their original files;
  // discovery/activation reports or skips invalid components independently.
  if (format === "agent-plugin" && prepared.some((file) => file.path === "apm.yml"))
    throw new ValidationError("Choose one package format; import the other manifest separately");
  const root = getPackagesDir();
  const path = join(root, name);
  if (existsSync(path)) throw new ConflictError(`Package already exists: ${name}`);
  mkdirSync(root, { recursive: true });
  mkdirSync(path);
  writeFileSync(join(path, manifestFile), content, { encoding: "utf8", flag: "wx" });
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
