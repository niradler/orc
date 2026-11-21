import { afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Direct `bun test` runs (outside ci:changed/ci:pr) inherit the real HOME, so a
 * test can open and rewrite the live ~/.orc/orc.db through the default resolution
 * (#474). The gates already isolate HOME per test step; this preload gives direct
 * runs the same protection. Skipped when HOME already lives under the temp root.
 *
 * The throwaway home is removed when the run ends, including failure paths, by
 * three cooperating mechanisms (the bun test runner fires no process exit hooks,
 * and fixtures can hold the home's files open past afterAll):
 * - a global afterAll and an exit hook remove it in-process when nothing locks it;
 * - a detached bun cleaner waits for the test process to die (every handle
 *   released) and then removes it — it survives direct `bun test` runs, but the
 *   `bun run` wrapper's Windows process job kills it, and endpoint policy can
 *   block non-bun children, so it cannot be the only guarantee;
 * - the next preload sweeps homes whose owner pid is gone (or that are over a
 *   day old), which reaps anything the first two missed, including hard crashes.
 */
export function isolateTestHome(): void {
  const current = process.env.HOME ?? process.env.USERPROFILE;
  try {
    if (current && realpathSync(current).startsWith(realpathSync(tmpdir()))) return;
  } catch {
    // A missing HOME is not the real home; fall through and create one.
  }
  sweepOrphanedHomes();
  const home = mkdtempSync(join(tmpdir(), `orc-test-home-${process.pid}-`));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.LOCALAPPDATA = join(home, "AppData", "Local");
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  const remove = () => {
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {}
  };
  afterAll(remove);
  process.on("exit", remove);

  const script = join(tmpdir(), `orc-test-cleaner-${process.pid}.js`);
  const code = `const fs=require("node:fs");const home=${JSON.stringify(home)};const pid=${process.pid};const script=${JSON.stringify(script)};const deadline=Date.now()+60000;const tick=()=>{let alive=true;try{process.kill(pid,0)}catch{alive=false}if(alive&&Date.now()<deadline)return setTimeout(tick,100);try{fs.rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:200})}catch{}try{fs.rmSync(script,{force:true})}catch{}};tick();`;
  writeFileSync(script, code);
  spawn(process.execPath, [script], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sweepOrphanedHomes(): void {
  const root = realpathSync(tmpdir());
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const entry of readdirSync(root)) {
    const target = join(root, entry);
    const owned = entry.match(/^orc-test-(?:home|cleaner)-(\d+)(?:-|\.)/);
    if (owned) {
      if (processAlive(Number(owned[1]))) continue;
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {}
      continue;
    }
    // Older-format homes carry no owner pid; reap them by age alone.
    if (/^orc-test-home-/.test(entry)) {
      try {
        if (statSync(target).mtimeMs < dayAgo) rmSync(target, { recursive: true, force: true });
      } catch {}
    }
  }
}

isolateTestHome();
