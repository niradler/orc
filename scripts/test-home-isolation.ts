import { afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

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
 *   released) and then removes it; if the process outlives the deadline it
 *   abandons the home rather than deleting a live run's files. It survives direct
 *   `bun test` runs, but the `bun run` wrapper's Windows process job kills it, and
 *   endpoint policy can block non-bun children, so it cannot be the only guarantee;
 * - the next preload sweeps homes whose owner pid is gone (or that are over a
 *   day old), which reaps anything the first two missed, including hard crashes.
 */
export function isolateTestHome(): void {
  const current = process.env.HOME ?? process.env.USERPROFILE;
  try {
    const tempRoot = realpathSync(tmpdir());
    const resolved = current ? realpathSync(current) : "";
    // Compare on a separator boundary so a sibling like <tmpdir>-evil is not
    // mistaken for an already-isolated home.
    if (resolved === tempRoot || resolved.startsWith(tempRoot + sep)) return;
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
      rmSync(home, { recursive: true, force: true });
    } catch {}
  };
  afterAll(remove);
  process.on("exit", remove);

  const script = join(tmpdir(), `orc-test-cleaner-${process.pid}.js`);
  writeFileSync(script, cleanerSource(home, process.pid, script, Date.now() + 60_000));
  spawn(process.execPath, [script], { detached: true, stdio: "ignore", windowsHide: true })
    .on("error", () => {})
    .unref();
}

/**
 * The detached cleaner's source. It removes the home only once the owner pid is
 * gone; a live owner at the deadline means a long direct run, so it abandons the
 * home (the next preload's sweep reaps it) instead of deleting files mid-run.
 */
export function cleanerSource(home: string, pid: number, script: string, deadline: number): string {
  return `const fs=require("node:fs");const home=${JSON.stringify(home)};const pid=${pid};const script=${JSON.stringify(script)};const deadline=${deadline};const alive=()=>{try{process.kill(pid,0);return true}catch(e){return e.code==="EPERM"}};const tick=()=>{if(alive()){if(Date.now()<deadline)return setTimeout(tick,100);try{fs.rmSync(script,{force:true})}catch{}return}try{fs.rmSync(home,{recursive:true,force:true})}catch{}try{fs.rmSync(script,{force:true})}catch{}};tick();`;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but is owned by another user or a higher
    // integrity level (pid reuse). Treat it as alive so the sweep never deletes
    // a live run's home.
    return (error as NodeJS.ErrnoException).code === "EPERM";
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
