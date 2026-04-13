import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));
mkdirSync("dist", { recursive: true });

// Ensure the web dashboard is built before we bundle the CLI. `bun build --compile`
// cannot embed static HTML/JS assets, so we ship them as a `dist/web/` directory
// alongside each binary and the API server serves them at runtime.
console.log("Building web dashboard...");
{
  const proc = Bun.spawnSync(["bun", "run", "--filter", "@orc/web", "build"], {
    stderr: "inherit",
    stdout: "inherit",
  });
  if (proc.exitCode !== 0) process.exit(1);
}

const webDistSrc = join("..", "web", "dist");
const webDistDest = join("dist", "web");
if (!existsSync(join(webDistSrc, "index.html"))) {
  console.error(`Expected ${webDistSrc}/index.html after web build — aborting.`);
  process.exit(1);
}
rmSync(webDistDest, { recursive: true, force: true });
cpSync(webDistSrc, webDistDest, { recursive: true });
console.log(`Copied web dist → ${webDistDest}`);

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

console.log(
  "All builds complete. Ship dist/web/ alongside each binary for the dashboard to work.",
);
