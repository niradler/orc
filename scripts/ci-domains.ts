import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const RUN_ALL_FILES = new Set([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "bunfig.toml",
  "biome.json",
  "biome.jsonc",
  "Dockerfile",
  ".dockerignore",
]);
const RUN_ALL_PREFIXES = [
  "patches/",
  "scripts/ci-",
  "scripts/pre-push",
  "scripts/tsconfig",
  ".github/",
  ".githooks/",
];
const OWNED_PREFIXES = ["scripts/", "docs/"];
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "coverage",
  "out",
  ".output",
  ".git",
  ".orc",
  ".claude",
  ".qwen",
  ".demo",
  ".examples",
  ".temp",
]);
const SOURCE_FILE = /\.(tsx|ts|mts|cts|jsx|js|mjs|cjs)$/;
const TEST_FILE = /[._](test|spec)\.(tsx|ts|mts|cts|jsx|js|mjs|cjs)$/;

export type PackageDomain = {
  name: string;
  folder: string;
  hasTestScript: boolean;
  /** The package's test script pins --max-concurrency=1; per-file runs must honor it too. */
  serialTests: boolean;
};

export type DomainSelection = {
  runAll: boolean;
  packageNames: string[];
  directNames: string[];
  changedPaths: string[];
  reasons: string[];
};

type PackageManifest = {
  name?: string;
  scripts?: { test?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

function readManifest(root: string, folder: string): PackageManifest {
  const path = join(root, "packages", folder, "package.json");
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

function workspaceDependencyNames(manifest: PackageManifest): string[] {
  const fields = [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies];
  const names: string[] = [];
  for (const field of fields) {
    if (!field) continue;
    for (const [name, version] of Object.entries(field)) {
      if (version.startsWith("workspace:")) names.push(name);
    }
  }
  return names;
}

export function normalizeRepoPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function readPackageDomains(root: string): PackageDomain[] {
  const folders = readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const domains: PackageDomain[] = [];
  for (const folder of folders) {
    const manifest = readManifest(root, folder);
    if (!manifest.name) throw new Error(`packages/${folder}/package.json has no name`);
    const testScript = manifest.scripts?.test;
    domains.push({
      name: manifest.name,
      folder,
      hasTestScript: typeof testScript === "string",
      serialTests: typeof testScript === "string" && testScript.includes("--max-concurrency=1"),
    });
  }
  return domains;
}

export function dependentsByPackage(root: string, domains: PackageDomain[]): Map<string, string[]> {
  const dependents = new Map<string, string[]>(domains.map((domain) => [domain.name, []]));
  for (const domain of domains) {
    for (const dependency of workspaceDependencyNames(readManifest(root, domain.folder))) {
      const users = dependents.get(dependency);
      if (!users) continue;
      users.push(domain.name);
    }
  }
  for (const users of dependents.values()) users.sort();
  return dependents;
}

export function runsAllPackages(path: string): boolean {
  if (RUN_ALL_FILES.has(path)) return true;
  if (RUN_ALL_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  return /^tsconfig[^/]*\.json$/.test(path);
}

export function selectDomains(
  paths: string[],
  domains: PackageDomain[],
  dependents: Map<string, string[]>,
): DomainSelection {
  const direct = new Map<string, string[]>();
  const shared: string[] = [];
  const outside: string[] = [];
  const changedPaths = paths.map(normalizeRepoPath).filter(Boolean);
  for (const path of changedPaths) {
    if (runsAllPackages(path)) {
      shared.push(path);
      continue;
    }
    const domain = domains.find((item) => path.startsWith(`packages/${item.folder}/`));
    if (!domain) {
      outside.push(path);
      continue;
    }
    const files = direct.get(domain.name) ?? [];
    files.push(path);
    direct.set(domain.name, files);
  }
  if (shared.length > 0) {
    const all = domains.map((domain) => domain.name).sort();
    return {
      runAll: true,
      packageNames: all,
      directNames: all,
      changedPaths,
      reasons: shared.map((path) => `${path} changes shared infrastructure`),
    };
  }
  const selected = new Set(direct.keys());
  const via = new Map<string, string>();
  const queue = [...selected];
  while (queue.length > 0) {
    const name = queue.shift();
    if (!name) break;
    for (const dependent of dependents.get(name) ?? []) {
      if (selected.has(dependent)) continue;
      selected.add(dependent);
      via.set(dependent, name);
      queue.push(dependent);
    }
  }
  const packageNames = [...selected].sort();
  const reasons = packageNames.map((name) => {
    const files = direct.get(name);
    const first = files?.[0];
    if (files && first) {
      const extra = files.length > 1 ? ` and ${files.length - 1} more` : "";
      return `${name}: ${first}${extra}`;
    }
    return `${name}: depends on ${via.get(name) ?? "a changed package"}`;
  });
  if (outside.length > 0) {
    const sample = outside.slice(0, 5).join(", ");
    const extra = outside.length > 5 ? ` and ${outside.length - 5} more` : "";
    reasons.push(`no package tests: ${sample}${extra}`);
  }
  return {
    runAll: false,
    packageNames,
    directNames: [...direct.keys()].sort(),
    changedPaths,
    reasons,
  };
}

function testFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) found.push(...testFiles(path));
    } else if (TEST_FILE.test(entry.name)) found.push(path);
  }
  return found;
}

const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
  js: new Bun.Transpiler({ loader: "js" }),
  jsx: new Bun.Transpiler({ loader: "jsx" }),
};

function transpilerFor(file: string): Bun.Transpiler {
  if (file.endsWith(".tsx")) return transpilers.tsx;
  if (file.endsWith(".jsx")) return transpilers.jsx;
  return /\.[mc]?ts$/.test(file) ? transpilers.ts : transpilers.js;
}
const importCache = new Map<string, string[]>();

function localImports(file: string): string[] {
  const cached = importCache.get(file);
  if (cached) return cached;
  const imports: string[] = [];
  importCache.set(file, imports);
  if (!SOURCE_FILE.test(file)) return imports;
  for (const { path } of transpilerFor(file).scanImports(readFileSync(file, "utf8"))) {
    try {
      const resolved = Bun.resolveSync(path, dirname(file));
      if (!/[\\/]node_modules[\\/]/.test(resolved) && existsSync(resolved)) imports.push(resolved);
    } catch {}
  }
  return imports;
}

export function isSourceFile(path: string): boolean {
  return SOURCE_FILE.test(path);
}

export function affectedTestFiles(root: string, folder: string, changedPaths: string[]): string[] {
  const realRoot = realpathSync(root);
  const changed = new Set(changedPaths.map((path) => join(realRoot, path)));
  const packageRoot = join(realRoot, "packages", folder);
  return testFiles(packageRoot)
    .filter((test) => {
      const seen = new Set<string>();
      const queue = [test];
      for (let file = queue.pop(); file; file = queue.pop()) {
        if (changed.has(file)) return true;
        if (seen.has(file)) continue;
        seen.add(file);
        queue.push(...localImports(file));
      }
      return false;
    })
    .map((path) => `./${normalizeRepoPath(relative(packageRoot, path))}`)
    .sort();
}

export function unownedSourcePaths(paths: string[], domains: PackageDomain[]): string[] {
  return paths.filter((path) => {
    const normalized = normalizeRepoPath(path);
    if (OWNED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
    return !domains.some((domain) => normalized.startsWith(`packages/${domain.folder}/`));
  });
}

export function sourceFiles(root: string): string[] {
  const found: string[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(join(directory, entry.name));
        continue;
      }
      if (!SOURCE_FILE.test(entry.name)) continue;
      found.push(normalizeRepoPath(relative(root, join(directory, entry.name))));
    }
  }
  walk(root);
  return found.sort();
}

export function unownedSourceFiles(root: string): string[] {
  const domains = readPackageDomains(root);
  return unownedSourcePaths(sourceFiles(root), domains);
}

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    timeout: 30_000,
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new Error(detail || `git ${args.join(" ")} failed`);
  }
  return result.stdout.toString();
}

function refExists(root: string, ref: string): boolean {
  const result = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", ref], {
    timeout: 30_000,
    cwd: root,
    stdout: "ignore",
    stderr: "ignore",
  });
  return result.exitCode === 0;
}

export function defaultCompareBase(root: string): string {
  if (refExists(root, "origin/master")) return "origin/master";
  if (refExists(root, "master")) return "master";
  throw new Error("No master branch to compare. Pass one: --changed <ref>");
}

export function changedFiles(root: string, base: string): string[] {
  const mergeBase = git(root, ["merge-base", base, "HEAD"]).trim();
  return git(root, ["diff", "--no-renames", "--name-only", "-z", mergeBase, "--"])
    .split("\0")
    .filter((line) => line.length > 0);
}
