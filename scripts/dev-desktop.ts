import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { installerName, run, TARGETS } from "./release-lib.js";
import { installDesktop } from "./update-desktop.js";

const DESKTOP = join(import.meta.dir, "../packages/desktop");
const BUILD_TIMEOUT = 15 * 60_000;

const os = { win32: "win", darwin: "mac", linux: "linux" }[process.platform as string];
const target = TARGETS.find((item) => item.os === os && item.arch === process.arch);
if (!target) throw new Error(`dev:desktop has no target for ${process.platform}-${process.arch}`);

const { version } = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8")) as {
  version: string;
};
const installer = join(DESKTOP, "release", installerName(version, target.id));

if (!process.argv.includes("--skip-build")) {
  run("bun", ["run", "bundle"], { cwd: DESKTOP, timeout: BUILD_TIMEOUT });
  run("bun", ["run", "bin", "--only", target.id], { cwd: DESKTOP, timeout: BUILD_TIMEOUT });
  run("bunx", ["electron-builder", `--${target.os}`, `--${target.arch}`, "--publish", "never"], {
    cwd: DESKTOP,
    timeout: BUILD_TIMEOUT,
  });
}

if (!existsSync(installer)) throw new Error(`Installer not found: ${installer}`);
await installDesktop({ version, installer });
console.log(`Installed local desktop build ${version} from ${installer}`);
