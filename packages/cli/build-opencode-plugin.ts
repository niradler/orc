import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Bundle the OpenCode plugin into the CLI output as a loadable plugin package.
 * OpenCode resolves a plugin path through package.json, so the directory needs
 * both the bundle and a manifest; a single .js file is ignored by the host.
 */
const cliRoot = import.meta.dir;
const out = join(cliRoot, "dist", "opencode-plugin");
const version = (
  JSON.parse(readFileSync(join(cliRoot, "..", "opencode", "package.json"), "utf8")) as {
    version: string;
  }
).version;
mkdirSync(out, { recursive: true });
const proc = Bun.spawnSync([
  "bun",
  "build",
  join(cliRoot, "..", "opencode", "src", "plugin.ts"),
  "--target",
  "bun",
  "--outfile",
  join(out, "index.js"),
]);
if (proc.exitCode !== 0) {
  console.error(proc.stderr.toString());
  process.exit(1);
}
writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name: "@orc/opencode",
      version,
      type: "module",
      main: "index.js",
      exports: { ".": "./index.js" },
    },
    null,
    2,
  )}\n`,
);
console.log(`Built OpenCode plugin ${out}`);
