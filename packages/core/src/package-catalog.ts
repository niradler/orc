import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix, relative } from "node:path";
import { NotFoundError, ValidationError } from "./errors.js";
import { packageToolCommands, qualifyPackageCommand } from "./package-launch.js";
import { createPackage, parseApmManifest, readPackage } from "./package-service.js";
import { parsePluginManifest, validatePluginMcp } from "./plugin-service.js";
import type {
  PackageCandidate,
  PackageDiscovery,
  PackageFormat,
  PackageFull,
} from "./primitive-types.js";
import { listSkillFiles, readSkillFile } from "./skill-files.js";
import {
  parseSkillRepository,
  readRepositoryFile,
  readTree,
  resolveCommit,
} from "./skill-import.js";

export type { PackageCandidate, PackageDiscovery } from "./primitive-types.js";

const acquisitions = new Map<
  string,
  { root: string; expires: number; packages: PackageCandidate[] }
>();
function acquiredPackageFolders(root: string): string[] {
  const candidates: string[] = [];
  let visited = 0;
  function walk(directory: string, depth: number) {
    if (depth > 12 || ++visited > 2048)
      throw new ValidationError("Package tree exceeds the discovery limit");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (existsSync(join(path, "apm.yml")) || existsSync(join(path, "plugin.json")))
        candidates.push(path);
      if (candidates.length > 64)
        throw new ValidationError("Too many packages; use a package subfolder reference");
      walk(path, depth + 1);
    }
  }
  if (existsSync(root)) walk(root, 0);
  return candidates;
}

export function validateApmSource(source: string): string {
  const value = source.trim();
  if (value.length > 2048 || Array.from(value).some((character) => character.charCodeAt(0) <= 32))
    throw new ValidationError("Enter one Git repository reference without whitespace");
  if (!value.includes("://")) {
    if (
      !/^[a-zA-Z0-9][\w-]*\/[\w.-]+(?:\/[\w.-]+)*(?:#[\w./-]+)?$/.test(value) ||
      value.split(/[/#]/).includes("..")
    )
      throw new ValidationError("Use owner/repo, an APM package subpath, or an HTTPS Git URL");
    return value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("Invalid Git repository URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    !["github.com", "gitlab.com", "bitbucket.org", "dev.azure.com"].includes(url.hostname)
  )
    throw new ValidationError(
      "Use an HTTPS GitHub, GitLab, Bitbucket or Azure DevOps URL without embedded credentials or query parameters",
    );
  if (url.pathname.split("/").some((part) => part === "..") || !url.pathname.replace(/^\//, ""))
    throw new ValidationError("Invalid repository path");
  return value;
}

/** Native APM acquisition also supports credentials already configured on the host. */
export async function acquireApmSource(
  source: string,
): Promise<{ token: string; source: string; packages: PackageCandidate[] }> {
  const value = validateApmSource(source);
  for (const [token, item] of acquisitions)
    if (item.expires < Date.now()) acquisitions.delete(token);
  if (acquisitions.size >= 8)
    throw new ValidationError("Too many pending imports; finish one or try again in 15 minutes");
  const root = mkdtempSync(join(tmpdir(), "orc-apm-source-"));
  await runApm(["install", value, "--target", "copilot", "--only", "apm"], root);
  const packages: PackageCandidate[] = [];
  for (const path of acquiredPackageFolders(join(root, "apm_modules"))) {
    const format = existsSync(join(path, "apm.yml")) ? "apm" : "agent-plugin";
    try {
      const content = readSkillFile(
        path,
        format === "apm" ? "apm.yml" : "plugin.json",
        false,
      ).content;
      const manifest =
        format === "apm" ? parseApmManifest(content) : parsePluginManifest(content).manifest;
      packages.push({
        name: manifest.name,
        description: manifest.description ?? "",
        format,
        path: relative(root, path).replaceAll("\\", "/"),
        installed: Boolean(readPackage(manifest.name)),
      });
    } catch {
      /* Runtime-native plugin formats are not portable catalog formats. */
    }
  }
  const token = crypto.randomUUID();
  acquisitions.set(token, { root, packages, expires: Date.now() + 15 * 60_000 });
  return { token, source: value, packages };
}

export function importAcquiredPackage(token: string, path: string): PackageFull {
  const acquired = acquisitions.get(token);
  if (!acquired || acquired.expires < Date.now())
    throw new ValidationError("Import selection expired; acquire the source again");
  const selected = acquired.packages.find((pkg) => pkg.path === path);
  if (!selected) throw new ValidationError("Choose a package from the acquired source");
  const directory = join(acquired.root, selected.path);
  const manifestFile = selected.format === "apm" ? "apm.yml" : "plugin.json";
  const content = readSkillFile(directory, manifestFile, false).content;
  const files = listSkillFiles(directory, manifestFile).map((ref) => {
    const file = readSkillFile(directory, ref.name, false);
    return { path: ref.name, content: file.content, encoding: file.encoding };
  });
  const pkg = createPackage(selected.name, content, files, selected.format, true);
  acquisitions.delete(token);
  return pkg;
}

export async function discoverRepositoryPackages(source: string): Promise<PackageDiscovery> {
  const origin = parseSkillRepository(source);
  if (origin.skill) throw new ValidationError("Use a GitHub repository or package folder URL");
  const commit = await resolveCommit(origin.repository, origin.ref);
  const tree = await readTree(origin.repository, commit);
  const manifests = tree.filter(
    (entry) =>
      entry.type === "blob" &&
      ["100644", "100755"].includes(entry.mode) &&
      /(^|\/)(apm\.yml|plugin\.json)$/.test(entry.path) &&
      (!origin.path || entry.path.startsWith(`${origin.path}/`)),
  );
  if (manifests.length > 64)
    throw new ValidationError("Too many manifests; use a package subfolder URL");
  const packages: PackageCandidate[] = [];
  const issues: PackageDiscovery["issues"] = [];
  for (const entry of manifests) {
    try {
      const content = (await readRepositoryFile(origin.repository, commit, entry.path)).toString(
        "utf8",
      );
      const format = entry.path.endsWith("apm.yml") ? "apm" : "agent-plugin";
      const manifest =
        format === "apm" ? parseApmManifest(content) : parsePluginManifest(content).manifest;
      const path = posix.dirname(entry.path) === "." ? "" : posix.dirname(entry.path);
      packages.push({
        name: manifest.name,
        description: manifest.description ?? "",
        path,
        format,
        installed: Boolean(readPackage(manifest.name)),
      });
    } catch (error) {
      issues.push({
        path: entry.path,
        error: error instanceof ValidationError ? error.message : "Unsupported package manifest",
      });
    }
  }
  return { repository: origin.repository, commit, source, packages, issues };
}

export function requireApm(): string[] {
  const command = packageToolCommands().apm;
  if (!command)
    throw new ValidationError(
      "Install APM 0.33.0 or newer on the API machine, or set ORC_APM_PATH to its executable",
    );
  qualifyPackageCommand(command, "0.33.0");
  return command;
}

async function boundedOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let output = "";
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    output = (output + decoder.decode(value, { stream: true })).slice(-32768);
  }
  return output;
}

let activeOperations = 0;
export async function runApm(args: string[], cwd: string): Promise<void> {
  if (activeOperations >= 2)
    throw new ValidationError("APM is busy; wait for the current operation to finish");
  const command = requireApm();
  activeOperations++;
  try {
    const child = Bun.spawn([...command, ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      boundedOutput(child.stdout),
      boundedOutput(child.stderr),
    ]);
    // Do not return upstream output: it may contain credentials or MCP environment values.
    if (code !== 0) {
      const text = `${out}\n${err}`;
      const hint = /trust|approval|approve|prompt/i.test(text)
        ? " This package requires approval; install it interactively in a terminal."
        : /local path dependency/i.test(text)
          ? " APM cannot export local-path dependencies; replace them with remote references."
          : /secret|credential/i.test(text)
            ? " Remove embedded credentials before exporting."
            : " Check the manifest, dependency references and APM compatibility.";
      throw new ValidationError(`APM ${args[0]} failed.${hint}`);
    }
  } finally {
    activeOperations--;
  }
}

export async function importRepositoryPackage(input: {
  source: string;
  commit: string;
  path: string;
  format: PackageFormat;
}): Promise<PackageFull> {
  if (!/^[a-f0-9]{40}$/.test(input.commit)) throw new ValidationError("Invalid Git commit");
  const origin = parseSkillRepository(input.source);
  // Rediscover the requested immutable tree so submitted paths cannot escape the source.
  const source = `https://github.com/${origin.repository}/tree/${input.commit}${origin.path ? `/${origin.path}` : ""}`;
  const discovery = await discoverRepositoryPackages(source);
  const chosen = discovery.packages.find(
    (pkg) => pkg.path === input.path && pkg.format === input.format,
  );
  if (!chosen)
    throw new ValidationError(
      "Selected package is outside this source or has an unsupported manifest",
    );
  if (chosen.installed) throw new ValidationError("This package already exists in your catalog");
  const root = mkdtempSync(join(tmpdir(), "orc-package-import-"));
  const reference = `${origin.repository}${input.path ? `/${input.path}` : ""}#${input.commit}`;
  await runApm(["install", reference, "--target", "copilot", "--only", "apm"], root);
  const candidates: string[] = [];
  function walk(path: string, depth: number) {
    if (depth > 12 || candidates.length > 128)
      throw new ValidationError("APM package tree exceeds the discovery limit");
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".git") continue;
      const directory = join(path, entry.name);
      const file = input.format === "apm" ? "apm.yml" : "plugin.json";
      if (existsSync(join(directory, file))) candidates.push(directory);
      walk(directory, depth + 1);
    }
  }
  walk(join(root, "apm_modules"), 0);
  const manifestFile = input.format === "apm" ? "apm.yml" : "plugin.json";
  for (const directory of candidates) {
    const content = readSkillFile(directory, manifestFile, false).content;
    let name: string;
    try {
      name =
        input.format === "apm"
          ? parseApmManifest(content).name
          : parsePluginManifest(content).manifest.name;
    } catch {
      continue;
    }
    if (name !== chosen.name) continue;
    const refs = listSkillFiles(directory, manifestFile).filter(
      (file) => !file.name.startsWith(".git/"),
    );
    const files = refs.map((ref) => {
      const file = readSkillFile(directory, ref.name, false);
      return { path: ref.name, content: file.content, encoding: file.encoding };
    });
    return createPackage(name, content, files, input.format, true);
  }
  throw new ValidationError(
    "APM did not acquire the selected package. Check its target and trust requirements.",
  );
}

export async function exportPackageArtifact(
  name: string,
): Promise<{ filename: string; content: string; format: string }> {
  const pkg = readPackage(name);
  if (!pkg) throw new NotFoundError("Package", name);
  if (pkg.format === "agent-plugin" && pkg.files.some((file) => file.name === "mcp.json")) {
    const file = readSkillFile(pkg.path, "mcp.json", false);
    validatePluginMcp([{ path: "mcp.json", content: file.content, encoding: file.encoding }]);
  }
  const stage = mkdtempSync(join(tmpdir(), "orc-package-export-"));
  const project = join(stage, "project");
  mkdirSync(project);
  for (const ref of pkg.files) {
    const file = readSkillFile(pkg.path, ref.name, false);
    const stagedName =
      pkg.format === "agent-plugin" && ref.name.startsWith("skills/")
        ? `.apm/${ref.name}`
        : ref.name;
    const destination = join(project, stagedName);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, Buffer.from(file.content, file.encoding), { flag: "wx" });
  }
  // APM requires apm.yml even when authoring a portable plugin. This adapter is
  // isolated from the original source and preserves its portable components.
  let manifest: Record<string, unknown> =
    pkg.format === "apm"
      ? parseApmManifest(pkg.content)
      : {
          name: pkg.name,
          version: pkg.version || "1.0.0",
          description: pkg.description,
          dependencies: {},
        };
  if (pkg.format === "agent-plugin" && existsSync(join(project, "mcp.json"))) {
    const mcp = JSON.parse(readSkillFile(project, "mcp.json", false).content);
    if (!mcp.mcpServers || typeof mcp.mcpServers !== "object" || Array.isArray(mcp.mcpServers))
      throw new ValidationError("Fix the plugin MCP configuration before exporting");
    manifest.dependencies = {
      mcp: Object.entries(mcp.mcpServers).map(([name, value]) => {
        const config = value as Record<string, unknown>;
        return {
          ...config,
          name,
          registry: false,
          transport: config.type === "streamable-http" ? "http" : config.type,
        };
      }),
    };
  }
  manifest = { ...manifest, dependencies: manifest.dependencies ?? {} };
  writeFileSync(join(project, "apm.yml"), Bun.YAML.stringify(manifest), { flag: "wx" });
  await runApm(["install", "--target", "copilot"], project);
  const format = pkg.format === "agent-plugin" ? "agent-plugin" : "claude-plugin";
  const output = join(stage, "output");
  await runApm(["pack", "--format", format, "--archive", "--output", output], project);
  const archives = readdirSync(output).filter((file) => file.endsWith(".zip"));
  if (archives.length !== 1) throw new ValidationError("APM did not produce one package archive");
  const archive = join(output, archives[0] as string);
  if (lstatSync(archive).isSymbolicLink() || lstatSync(archive).size > 32 * 1024 * 1024)
    throw new ValidationError("Invalid or oversized APM export");
  return {
    filename: `${pkg.name}-${format}.zip`,
    content: readFileSync(archive).toString("base64"),
    format,
  };
}

export function writePackageCommand(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): string {
  const root = join(homedir(), ".orc", "package-commands");
  if (existsSync(root) && lstatSync(root).isSymbolicLink())
    throw new ValidationError("Package command directory cannot be a symlink");
  mkdirSync(root, { recursive: true });
  const path = join(root, `${crypto.randomUUID()}.ts`);
  const source = argv[2];
  if (argv[1] !== "--eval" || !source) throw new ValidationError("Invalid launch plan");
  writeFileSync(path, source, { mode: 0o600, flag: "wx" });
  const quote = (value: string) =>
    platform === "win32"
      ? `'${value.replaceAll("'", "''")}'`
      : `'${value.replaceAll("'", "'\\''")}'`;
  return `${platform === "win32" ? "& " : ""}${quote(argv[0] as string)} ${quote(path)}`;
}
