import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { help: { type: "boolean" }, output: { type: "string" } },
});
if (values.help) {
  console.log(
    "Usage: bun packages/desktop/scripts/mac-update-acceptance.ts [--output <result.json>]\nBuilds and upgrades two private ad-hoc signed macOS apps using the production About bridge. Cleans fixture apps and data after teardown.",
  );
  process.exit(0);
}
assert(process.platform === "darwin" && process.arch === "arm64", "Run on an Apple Silicon Mac");
const repository = resolve(import.meta.dirname, "../../..");
const desktop = join(repository, "packages/desktop");
const bun = join(repository, "node_modules/.bin/bun");
const output = resolve(values.output ?? join(tmpdir(), "orc-mac-update-result.json"));
const parent = realpathSync(mkdtempSync(join(tmpdir(), "orc-update-e2e-")));
const root = join(parent, "mac");
const feed = join(root, "feed");
const identity = `orc-update-fixture-${randomBytes(6).toString("hex")}`;
const oldVersion = "0.1.61";
const newVersion = "0.1.62";
mkdirSync(feed, { recursive: true });
mkdirSync(join(root, "home/.orc"), { recursive: true });
writeFileSync(
  join(root, "fixture-owned.json"),
  JSON.stringify({ identity, oldVersion, newVersion }),
);
writeFileSync(
  join(root, "home/.orc/config.json"),
  JSON.stringify({
    api: { secret: randomBytes(24).toString("hex") },
    agent_loop: { enabled: false },
  }),
  { mode: 0o600 },
);
writeFileSync(join(root, "bootstrap.json"), JSON.stringify({ identity, roots: { darwin: root } }));
const env = { ...process.env, PATH: `${dirname(bun)}:${process.env.PATH}` };
async function run(command: string, args: string[], cwd = repository): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit", timeout: 300_000 });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? accept() : reject(new Error(`${command} failed (${code ?? signal})`)),
    );
  });
}
try {
  await run(bun, ["run", "bundle"], desktop);
  await run(
    bun,
    [
      "build",
      "scripts/update-fixture.ts",
      "--outfile",
      "dist/update-fixture.js",
      "--target",
      "node",
      "--format",
      "esm",
      "--external",
      "electron",
      "--external",
      "electron-updater",
    ],
    desktop,
  );
  const baseline = join(repository, "packages/cli/dist/orc-mac-arm64");
  assert(existsSync(baseline), "Build the host CLI with packages/cli/build.ts --only host first");
  const candidate = join(root, "orc-candidate");
  await run(
    bun,
    [
      "build",
      "src/bin-entry.ts",
      "--compile",
      "--minify",
      "--target",
      "bun-darwin-arm64",
      "--outfile",
      candidate,
      "--define",
      `process.env.ORC_VERSION=${JSON.stringify(newVersion)}`,
    ],
    join(repository, "packages/cli"),
  );
  for (const [version, binary] of [
    [oldVersion, baseline],
    [newVersion, candidate],
  ] as const) {
    const config = join(root, "builder.json");
    writeFileSync(
      config,
      JSON.stringify({
        appId: `dev.orc.${identity}`,
        productName: "orc",
        directories: { output: join(root, "build") },
        electronDist: join(desktop, "node_modules/electron/dist"),
        extraMetadata: { main: "dist/update-fixture.js", version },
        files: ["dist/**", "build/icon.png", "package.json"],
        mac: {
          identity: "-",
          target: "dir",
          extraResources: [
            { from: binary, to: "orc" },
            { from: join(root, "bootstrap.json"), to: "update-fixture.json" },
          ],
        },
      }),
    );
    await run(
      "node",
      [
        "node_modules/electron-builder/cli.js",
        "--mac",
        "--arm64",
        "--dir",
        "--publish",
        "never",
        "--config",
        config,
      ],
      desktop,
    );
    const app = join(root, "build/mac-arm64/orc.app");
    if (version === oldVersion) await run("/usr/bin/ditto", [app, join(root, "old/orc.app")]);
    else {
      const name = `orc-${newVersion}-mac-arm64.dmg`;
      const image = join(feed, name);
      await run("/usr/bin/hdiutil", [
        "create",
        "-srcfolder",
        dirname(app),
        "-format",
        "UDZO",
        "-volname",
        identity,
        image,
      ]);
      const digest = createHash("sha256").update(readFileSync(image)).digest("hex");
      writeFileSync(
        join(feed, "releases.json"),
        JSON.stringify([
          {
            tag_name: `v${newVersion}`,
            draft: false,
            prerelease: false,
            body: "Native Mac update acceptance",
            assets: [
              {
                name,
                size: statSync(image).size,
                digest: `sha256:${digest}`,
                browser_download_url: `https://github.com/niradler/orc/releases/download/v${newVersion}/${name}`,
              },
            ],
          },
        ]),
      );
    }
  }
  await run(bun, [
    "packages/desktop/scripts/update-smoke.ts",
    "--root",
    root,
    "--installer",
    join(root, "old/orc.app"),
    "--feed",
    feed,
  ]);
  copyFileSync(join(root, "result.json"), output);
  console.log(`Native macOS update evidence: ${output}`);
} finally {
  if (existsSync(join(root, "result.json")) && !existsSync(output))
    copyFileSync(join(root, "result.json"), output);
  const mount = join(root, "home/userdata/mac-update/mount");
  if (existsSync(mount) && statSync(mount).dev !== statSync(dirname(mount)).dev) {
    const detached = spawnSync("/usr/bin/hdiutil", ["detach", mount, "-force"], {
      timeout: 30_000,
      stdio: "inherit",
    });
    assert.equal(detached.status, 0, "Fixture disk image could not be detached");
  }
  rmSync(parent, { recursive: true, force: true });
  rmSync(join(desktop, "dist/update-fixture.js"), { force: true });
}
