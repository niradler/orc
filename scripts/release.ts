#!/usr/bin/env bun
/**
 * Local release for orc — replaces the (removed) GitHub release workflow.
 * Run manually from the repo root: `bun run scripts/release.ts [flags]`.
 *
 * Steps (in order):
 *   1. Preflight  — version alignment, clean git tree, on master, required tools present.
 *   2. Binaries   — `build:bin` cross-compiles the 5 platform binaries.
 *   3. Checksums  — sha256 of each binary → dist/checksums.txt.
 *   4. npm        — `npm publish` orc-ai (its prepublishOnly runs build + validate:package).
 *   5. Tag        — create + push `v<version>`.
 *   6. GitHub     — `gh release create` with binaries + checksums attached.
 *   7. Docker     — multi-arch buildx build + push (niradler/orc:latest and :<version>).
 *
 * DRY-RUN by default: prints every command without running the outward-facing
 * ones. Pass --yes to actually publish/push. Skip steps with
 * --skip-binaries --skip-npm --skip-tag --skip-github --skip-docker.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CLI_DIR = join(ROOT, "packages", "cli");
const DIST = join(CLI_DIR, "dist");
const BIN_GLOB = [
  "orc-linux-x64",
  "orc-linux-arm64",
  "orc-mac-arm64",
  "orc-mac-x64",
  "orc-windows-x64.exe",
];
const DOCKER_IMAGE = "niradler/orc";

const args = new Set(process.argv.slice(2));
const EXECUTE = args.has("--yes");
const skip = (s: string) => args.has(`--skip-${s}`);
const isWin = process.platform === "win32";

function readJson(p: string): { version?: string } {
  return JSON.parse(readFileSync(p, "utf-8"));
}

function sh(cmd: string, cmdArgs: string[], cwd = ROOT): void {
  const printable = `${cmd} ${cmdArgs.join(" ")}`;
  if (!EXECUTE) {
    console.log(`  [dry-run] ${printable}`);
    return;
  }
  console.log(`  $ ${printable}`);
  const r = Bun.spawnSync([cmd, ...cmdArgs], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  if (r.exitCode !== 0) {
    console.error(`\n✗ Command failed (exit ${r.exitCode}): ${printable}`);
    process.exit(1);
  }
}

function capture(cmd: string, cmdArgs: string[]): string {
  const r = Bun.spawnSync([cmd, ...cmdArgs], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(r.stdout).trim();
}

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ── 1. Preflight ────────────────────────────────────────────────────────────
console.log(`→ orc local release ${EXECUTE ? "(EXECUTE)" : "(dry-run — pass --yes to publish)"}\n`);
console.log("[1/7] Preflight");

const version =
  readJson(join(ROOT, "package.json")).version ?? die("root package.json has no version");
const pkgDirs = readdirSync(join(ROOT, "packages"));
const mismatched = pkgDirs
  .map((d) => join(ROOT, "packages", d, "package.json"))
  .filter(existsSync)
  .filter((p) => readJson(p).version !== version);
if (mismatched.length > 0) {
  die(
    `version mismatch (root is ${version}): ${mismatched.join(", ")} — all package.json must align`,
  );
}
console.log(`  ✓ all package.json aligned at v${version}`);

const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "master") console.warn(`  ! on branch '${branch}', expected 'master'`);
if (capture("git", ["status", "--porcelain"]) !== "") {
  die("git tree is dirty — commit or stash before releasing");
}
console.log("  ✓ clean git tree");

for (const tool of [
  "npm",
  "git",
  ...(skip("github") ? [] : ["gh"]),
  ...(skip("docker") ? [] : ["docker"]),
]) {
  const found = capture(isWin ? "where" : "which", [tool]);
  if (!found) die(`required tool not found on PATH: ${tool}`);
}
console.log("  ✓ required tools present");

// ── 2. Binaries ───────────────────────────────────────────────────────────-─
console.log("\n[2/7] Build platform binaries");
if (skip("binaries")) {
  console.log("  (skipped)");
} else {
  sh("bun", ["run", "build:bin"], CLI_DIR);
}

// ── 3. Checksums ─────────────────────────────────────────────────────────────
console.log("\n[3/7] Checksums");
if (skip("binaries")) {
  console.log("  (skipped — binaries not built)");
} else if (!EXECUTE) {
  console.log("  [dry-run] sha256(dist/orc-*) → dist/checksums.txt");
} else {
  const lines = BIN_GLOB.map((name) => {
    const file = join(DIST, name);
    if (!existsSync(file)) die(`expected binary missing: ${file}`);
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    return `${hash}  ${name}`;
  });
  writeFileSync(join(DIST, "checksums.txt"), `${lines.join("\n")}\n`);
  console.log(`  ✓ wrote dist/checksums.txt (${lines.length} binaries)`);
}

// ── 4. npm publish ───────────────────────────────────────────────────────────
console.log("\n[4/7] npm publish orc-ai (runs prepublishOnly = build + validate:package)");
if (skip("npm")) {
  console.log("  (skipped)");
} else {
  sh("npm", ["publish"], CLI_DIR);
}

// ── 5. Git tag ────────────────────────────────────────────────────────────────
console.log("\n[5/7] Git tag");
if (skip("tag")) {
  console.log("  (skipped)");
} else {
  sh("git", ["tag", `v${version}`]);
  sh("git", ["push", "origin", `v${version}`]);
}

// ── 6. GitHub release ─────────────────────────────────────────────────────────
console.log("\n[6/7] GitHub release");
if (skip("github")) {
  console.log("  (skipped)");
} else {
  const files = [...BIN_GLOB.map((n) => join(DIST, n)), join(DIST, "checksums.txt")];
  sh("gh", ["release", "create", `v${version}`, "--generate-notes", ...files]);
}

// ── 7. Docker ─────────────────────────────────────────────────────────────────
console.log("\n[7/7] Docker multi-arch build + push");
if (skip("docker")) {
  console.log("  (skipped)");
} else {
  sh("docker", [
    "buildx",
    "build",
    "--platform",
    "linux/amd64,linux/arm64",
    "--push",
    "-t",
    `${DOCKER_IMAGE}:latest`,
    "-t",
    `${DOCKER_IMAGE}:${version}`,
    ".",
  ]);
}

console.log(
  EXECUTE
    ? `\n✓ Released v${version}.`
    : `\n✓ Dry-run complete for v${version}. Re-run with --yes to publish.`,
);
