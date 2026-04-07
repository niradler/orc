import { mkdirSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));
mkdirSync("dist", { recursive: true });

const opentui_externals = [
  "@opentui/core-darwin-x64",
  "@opentui/core-darwin-arm64",
  "@opentui/core-linux-x64",
  "@opentui/core-linux-arm64",
  "@opentui/core-win32-x64",
  "@opentui/core-win32-arm64",
];

const targets = [
  { target: "bun-linux-x64", out: "dist/orc-linux-x64" },
  { target: "bun-linux-arm64", out: "dist/orc-linux-arm64" },
  { target: "bun-darwin-arm64", out: "dist/orc-mac-arm64" },
  { target: "bun-darwin-x64", out: "dist/orc-mac-x64" },
  { target: "bun-windows-x64", out: "dist/orc-windows-x64.exe" },
] as const;

for (const { target, out } of targets) {
  console.log(`Building ${out}...`);
  const proc = Bun.spawnSync([
    "bun",
    "build",
    "./src/index.ts",
    "--compile",
    "--minify",
    "--target",
    target,
    "--outfile",
    out,
    "--define",
    `process.env.ORC_VERSION=${JSON.stringify(pkg.version)}`,
    ...opentui_externals.flatMap((ext) => ["--external", ext]),
  ]);
  if (proc.exitCode !== 0) {
    console.error(proc.stderr.toString());
    process.exit(1);
  }
  console.log(proc.stdout.toString());
}

console.log("All builds complete.");
