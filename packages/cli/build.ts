import { mkdirSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));
mkdirSync("dist", { recursive: true });

// 1. Build the web dashboard
console.log("Building web dashboard...");
{
  const proc = Bun.spawnSync(["bun", "run", "--filter", "@orc/web", "build"], {
    stderr: "inherit",
    stdout: "inherit",
  });
  if (proc.exitCode !== 0) process.exit(1);
}

// 2. Generate the embedded-asset manifest (import with { type: "file" })
console.log("Generating web asset manifest...");
{
  const proc = Bun.spawnSync(["bun", "run", "scripts/generate-web-manifest.ts"], {
    stderr: "inherit",
    stdout: "inherit",
  });
  if (proc.exitCode !== 0) process.exit(1);
}

// 3. Cross-compile standalone binaries — each embeds the web dashboard.
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
    "./src/bin-entry.ts",
    "--compile",
    "--minify",
    "--target",
    target,
    "--outfile",
    out,
    "--define",
    `process.env.ORC_VERSION=${JSON.stringify(pkg.version)}`,
    "--external",
    "@tobilu/qmd",
    "--external",
    "node-llama-cpp",
    "--external",
    "@node-llama-cpp/*",
  ]);
  if (proc.exitCode !== 0) {
    console.error(proc.stderr.toString());
    process.exit(1);
  }
  console.log(proc.stdout.toString());
}

console.log("All builds complete. Each binary includes the web dashboard — no extra files needed.");
