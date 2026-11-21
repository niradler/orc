import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Direct `bun test` runs (outside ci:changed/ci:pr) inherit the real HOME, so a
 * test can open and rewrite the live ~/.orc/orc.db through the default resolution
 * (#474). The gates already isolate HOME per test step; this preload gives direct
 * runs the same protection. Skipped when HOME already lives under the temp root.
 */
export function isolateTestHome(): void {
  const current = process.env.HOME ?? process.env.USERPROFILE;
  try {
    if (current && realpathSync(current).startsWith(realpathSync(tmpdir()))) return;
  } catch {
    // A missing HOME is not the real home; fall through and create one.
  }
  const home = mkdtempSync(join(tmpdir(), "orc-test-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.LOCALAPPDATA = join(home, "AppData", "Local");
  process.env.XDG_CONFIG_HOME = join(home, ".config");
}

isolateTestHome();
