import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { installerName, run } from "./release-lib.js";
import { installDesktop } from "./update-desktop.js";

const DESKTOP = join(import.meta.dir, "../packages/desktop");
const BUILD_TIMEOUT = 15 * 60_000;

if (process.platform !== "win32") throw new Error("dev:desktop supports Windows only");

const { version } = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8")) as {
  version: string;
};
const installer = join(DESKTOP, "release", installerName(version, "windows-x64"));

if (!process.argv.includes("--skip-build")) {
  run("bun", ["run", "bundle"], { cwd: DESKTOP, timeout: BUILD_TIMEOUT });
  run("bun", ["run", "bin", "--only", "windows-x64"], { cwd: DESKTOP, timeout: BUILD_TIMEOUT });
  run("bunx", ["electron-builder", "--win", "--x64", "--publish", "never"], {
    cwd: DESKTOP,
    timeout: BUILD_TIMEOUT,
  });
}

if (!existsSync(installer)) throw new Error(`Installer not found: ${installer}`);
await installDesktop({ version, installer });
console.log(`Installed local desktop build ${version} from ${installer}`);
