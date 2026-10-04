#!/usr/bin/env bun
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  BINARIES,
  bumpPatch,
  completeStep,
  desktopMatrix,
  hostTarget,
  installerName,
  run,
  sha256,
  TARGETS,
} from "./release-lib.js";
import { installDesktop } from "./update-desktop.js";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "packages/cli");
const DESKTOP = join(ROOT, "packages/desktop");
const STATE = join(ROOT, ".orc/release-state.json");
const PLAN = join(ROOT, "scripts/release-plan.json");
const { values } = parseArgs({
  options: {
    yes: { type: "boolean" },
    resume: { type: "boolean" },
    check: { type: "boolean" },
    "ci-matrix": { type: "boolean" },
    help: { type: "boolean" },
  },
});

type State = {
  version: string;
  target: string;
  commit?: string;
  runId?: number;
  completed: string[];
  hashes?: Record<string, string>;
};
type Manifest = { version: string; [key: string]: unknown };
function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
function writeJson(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}
function command(tool: string, args: string[], cwd = ROOT, capture = false): string {
  return run(tool, args, { cwd, capture });
}
function manifests(): string[] {
  return [
    join(ROOT, "package.json"),
    ...readdirSync(join(ROOT, "packages"))
      .map((name) => join(ROOT, "packages", name, "package.json"))
      .filter(existsSync),
  ];
}
function checkClean(): void {
  if (command("git", ["status", "--porcelain"], ROOT, true))
    throw new Error("Commit your changes first; release requires a clean working tree.");
}
function validate(): void {
  command("bun", ["x", "biome", "check", "./packages", "./scripts"]);
  command("bun", ["run", "typecheck"]);
  command("bun", ["x", "tsc", "-p", "scripts/tsconfig.json"]);
  command("bun", ["test", "scripts/release.test.ts"]);
  command("bun", ["run", "test"]);
}

async function main(): Promise<void> {
  if (values.help) {
    console.log(
      "bun run release [--yes | --check | --resume --yes]\nDefault: print plan. --check: run all checks without bump/publish.\n--yes: test, bump patch, build, tag, release, npm, Docker, update desktop.\n--resume --yes: continue the same version after a failure. Only the tag is pushed; no branch push.",
    );
    return;
  }
  if (values["ci-matrix"]) {
    const plan = readJson<{ version: string; target: string }>(PLAN);
    console.log(
      JSON.stringify(
        desktopMatrix(
          plan.version,
          plan.target,
          readJson<Manifest>(join(ROOT, "package.json")).version,
        ),
      ),
    );
    return;
  }
  if (values.check) {
    validate();
    return;
  }
  if (values.resume && !values.yes) throw new Error("--resume requires --yes");
  const current = readJson<Manifest>(join(ROOT, "package.json")).version;
  const target = hostTarget();
  if (!TARGETS.some((t) => t.id === target)) throw new Error(`Unsupported release host: ${target}`);
  const version = values.resume ? readJson<State>(STATE).version : bumpPatch(current);
  if (!values.yes) {
    console.log(
      `Release v${version}: full checks → patch bump + lockfile → local CLI binaries + ${target} installer + smoke → version commit + tag push → Actions (${TARGETS.filter(
        (t) => t.id !== target,
      )
        .map((t) => t.id)
        .join(
          ", ",
        )}) → checksummed GitHub release → npm → Docker linux/amd64,linux/arm64 → install/relaunch desktop.\nRun bun run release --yes when ready. No branch is pushed.`,
    );
    return;
  }
  checkClean();
  let state: State;
  if (values.resume) {
    state = readJson<State>(STATE);
    if (
      state.target !== target ||
      state.version !== current ||
      (state.commit && state.commit !== command("git", ["rev-parse", "HEAD"], ROOT, true))
    )
      throw new Error("Resume requires the original release commit, version and host.");
  } else {
    if (existsSync(STATE)) {
      const previous = readJson<State>(STATE);
      if (!previous.completed.includes("install"))
        throw new Error(`Unfinished v${previous.version}; use --resume --yes.`);
    }
    for (const file of manifests())
      if (readJson<Manifest>(file).version !== current)
        throw new Error(`Version mismatch: ${file}`);
    command("gh", ["api", "user", "--jq", ".login"], ROOT, true);
    command("npm", ["whoami"], ROOT, true);
    const publishedVersions = JSON.parse(
      command("npm", ["view", "orc-ai", "versions", "--json"], ROOT, true),
    ) as string[];
    if (publishedVersions.includes(version))
      throw new Error(
        `npm orc-ai@${version} already exists; reconcile package versions before a new release.`,
      );
    command("docker", ["info", "--format", "{{.ServerVersion}}"], ROOT, true);
    command("git", ["fetch", "origin", "--tags"]);
    if (command("git", ["tag", "--list", `v${version}`], ROOT, true))
      throw new Error(`Tag v${version} already exists.`);
    validate();
    state = { version, target, completed: ["checks"] };
    mkdirSync(join(ROOT, ".orc"), { recursive: true });
    writeJson(STATE, state);
  }
  const save = (): void => writeJson(STATE, state);
  async function step(name: string, action: () => void | Promise<void>): Promise<void> {
    await completeStep(
      state.completed,
      name,
      async () => {
        console.log(`\n→ ${name} (v${version})`);
        await action();
      },
      save,
    );
  }
  const tag = `v${version}`;
  const artifacts = join(ROOT, ".orc", `release-${version}`);
  mkdirSync(artifacts, { recursive: true });
  await step("bump", () => {
    for (const file of manifests()) writeJson(file, { ...readJson<Manifest>(file), version });
    writeJson(PLAN, { version, target });
    command("bun", ["install", "--lockfile-only"]);
    command("git", [
      "add",
      "package.json",
      ...manifests()
        .slice(1)
        .map((p) => p.slice(ROOT.length + 1)),
      "bun.lock",
      "scripts/release-plan.json",
    ]);
    command("git", ["commit", "-m", `chore: release ${tag}`]);
    state.commit = command("git", ["rev-parse", "HEAD"], ROOT, true);
    save();
  });
  await step("build", () => {
    command("bun", ["run", "build"]);
    command("bun", ["run", "build:bin"], CLI);
    command("bun", ["run", "validate:package"], CLI);
    command(
      "bun",
      [
        "x",
        "electron-builder",
        `--${TARGETS.find((t) => t.id === target)?.os}`,
        `--${process.arch}`,
        "--publish",
        "never",
      ],
      DESKTOP,
    );
    command("bun", ["packages/desktop/scripts/smoke.ts"]);
    for (const file of BINARIES)
      if (!existsSync(join(CLI, "dist", file))) throw new Error(`Missing binary: ${file}`);
    if (!existsSync(join(DESKTOP, "release", installerName(version, target))))
      throw new Error("Missing local installer");
    checkClean();
  });
  await step("tag", () => {
    const existing = command("git", ["tag", "--list", tag], ROOT, true);
    if (!existing) command("git", ["tag", "-a", tag, "-m", `orc ${tag}`]);
    if (command("git", ["rev-list", "-n", "1", tag], ROOT, true) !== state.commit)
      throw new Error("Tag points at another commit");
    command("git", ["push", "origin", `refs/tags/${tag}`]);
  });
  await step("actions", async () => {
    const deadline = Date.now() + 60 * 60_000;
    while (!state.runId && Date.now() < deadline) {
      const runs = JSON.parse(
        command(
          "gh",
          [
            "run",
            "list",
            "--commit",
            state.commit ?? "",
            "--event",
            "push",
            "--json",
            "databaseId,workflowName",
            "--limit",
            "30",
          ],
          ROOT,
          true,
        ),
      ) as { databaseId: number; workflowName: string }[];
      const runId = runs.find((r) => r.workflowName === "Release desktop gaps")?.databaseId;
      if (runId) {
        state.runId = runId;
        save();
      } else await Bun.sleep(10_000);
    }
    if (!state.runId) throw new Error("Release workflow did not start; inspect GitHub Actions.");
    for (;;) {
      const result = JSON.parse(
        command(
          "gh",
          ["run", "view", String(state.runId), "--json", "status,conclusion,url"],
          ROOT,
          true,
        ),
      ) as { status: string; conclusion: string; url: string };
      console.log(`Actions: ${result.status} ${result.url}`);
      if (result.status === "completed") {
        if (result.conclusion !== "success")
          throw new Error(
            `Desktop workflow ${result.conclusion}: ${result.url}. Fix the cause; no release published.`,
          );
        break;
      }
      if (Date.now() > deadline)
        throw new Error("Timed out waiting for desktop builds; resume later.");
      await Bun.sleep(20_000);
    }
    command("gh", ["run", "download", String(state.runId), "--dir", artifacts]);
  });
  const files = [
    ...BINARIES.map((name) => join(CLI, "dist", name)),
    ...TARGETS.map((t) =>
      t.id === target
        ? join(DESKTOP, "release", installerName(version, t.id))
        : join(artifacts, `desktop-${t.id}`, installerName(version, t.id)),
    ),
  ];
  for (const file of files)
    if (!existsSync(file)) throw new Error(`Missing release artifact: ${file}`);
  const checksums = join(artifacts, "checksums.txt");
  const hashes = Object.fromEntries(files.map((file) => [basename(file), sha256(file)]));
  if (state.hashes && JSON.stringify(state.hashes) !== JSON.stringify(hashes))
    throw new Error(
      "Release artifacts changed after collection; refusing to publish or install different bytes.",
    );
  state.hashes = hashes;
  save();
  writeFileSync(
    checksums,
    `${files.map((file) => `${sha256(file)}  ${basename(file)}`).join("\n")}\n`,
  );
  await step("github", () => {
    const releases = JSON.parse(
      command("gh", ["release", "list", "--json", "tagName,isDraft", "--limit", "100"], ROOT, true),
    ) as { tagName: string; isDraft: boolean }[];
    const release = releases.find((r) => r.tagName === tag);
    if (!release)
      command("gh", [
        "release",
        "create",
        tag,
        "--verify-tag",
        "--draft",
        "--generate-notes",
        ...files,
        checksums,
      ]);
    else if (release.isDraft)
      command("gh", ["release", "upload", tag, ...files, checksums, "--clobber"]);
    command("gh", ["release", "edit", tag, "--draft=false", "--latest"]);
  });
  await step("npm", () => {
    const versions = JSON.parse(
      command("npm", ["view", "orc-ai", "versions", "--json"], ROOT, true),
    ) as string[];
    if (!versions.includes(version)) command("npm", ["publish"], CLI);
    if (command("npm", ["view", `orc-ai@${version}`, "version"], ROOT, true) !== version)
      throw new Error("npm version verification failed");
  });
  await step("docker", () => {
    const builders = command("docker", ["buildx", "ls", "--format", "{{.Name}}"], ROOT, true).split(
      /\r?\n/,
    );
    if (!builders.includes("orc-multiarch"))
      command("docker", [
        "buildx",
        "create",
        "--name",
        "orc-multiarch",
        "--driver",
        "docker-container",
      ]);
    command("docker", [
      "buildx",
      "build",
      "--builder",
      "orc-multiarch",
      "--platform",
      "linux/amd64,linux/arm64",
      "--push",
      "-t",
      `niradler/orc:${version}`,
      "-t",
      "niradler/orc:latest",
      ".",
    ]);
    command("docker", ["buildx", "imagetools", "inspect", `niradler/orc:${version}`]);
  });
  await step("install", () =>
    installDesktop({
      version,
      installer: join(DESKTOP, "release", installerName(version, target)),
    }),
  );
  console.log(
    `\nReleased and installed ${tag}: https://github.com/niradler/orc/releases/tag/${tag}`,
  );
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(
    "After correcting the failure, use bun run release --resume --yes if release-state.json was created.",
  );
  process.exitCode = 1;
});
