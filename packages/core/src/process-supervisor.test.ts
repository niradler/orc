import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("should replace only explicitly restarted server children in source and compiled launches", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orc-supervisor-test-"));
  const entry = join(directory, "server.ts");
  const counter = join(directory, "count");
  const binary = join(directory, process.platform === "win32" ? "server.exe" : "server");
  const supervisor = join(import.meta.dir, "process-supervisor.ts").replaceAll("\\", "/");
  writeFileSync(
    entry,
    `import {readFileSync,writeFileSync,existsSync} from "node:fs";
import {superviseServer,RESTART_EXIT_CODE} from ${JSON.stringify(supervisor)};
if(await superviseServer()) {
 const path=process.env.ORC_TEST_COUNTER;
 const count=existsSync(path)?Number(readFileSync(path,"utf8")):0;
 writeFileSync(path,String(count+1));
 process.exit(count===0?RESTART_EXIT_CODE:0);
}`,
  );
  const build = Bun.spawn([process.execPath, "build", entry, "--compile", "--outfile", binary], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60000,
  });
  const [buildOut, buildErr, buildCode] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ]);
  expect({ code: buildCode, output: buildCode ? buildOut + buildErr : "" }).toEqual({
    code: 0,
    output: "",
  });
  for (const argv of [[process.execPath, entry], [binary]]) {
    writeFileSync(counter, "0");
    const child = Bun.spawn(argv, {
      env: { ...process.env, ORC_TEST_COUNTER: counter },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15000,
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, output: code ? out + err : "" }).toEqual({ code: 0, output: "" });
    expect(readFileSync(counter, "utf8")).toBe("2");
  }
}, 60000);

test("should stop server children when their supervisor is terminated unexpectedly", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orc-supervisor-stop-"));
  const entry = join(directory, "server.ts");
  const pidFile = join(directory, "pid");
  const stoppedFile = join(directory, "stopped");
  const supervisor = join(import.meta.dir, "process-supervisor.ts").replaceAll("\\", "/");
  writeFileSync(
    entry,
    `import {writeFileSync} from "node:fs";
import {superviseServer} from ${JSON.stringify(supervisor)};
if(await superviseServer()) {
 process.on("SIGTERM",()=>{writeFileSync(process.env.ORC_TEST_STOPPED,"clean");process.exit(0)});
 writeFileSync(process.env.ORC_TEST_PID,String(process.pid));
 setInterval(()=>{},1000);
}`,
  );
  const parent = Bun.spawn([process.execPath, entry], {
    env: { ...process.env, ORC_TEST_PID: pidFile, ORC_TEST_STOPPED: stoppedFile },
    stdout: "ignore",
    stderr: "ignore",
    timeout: 10000,
  });
  let childPid: number | undefined;
  function alive(): boolean {
    if (!childPid) return false;
    try {
      process.kill(childPid, 0);
      return true;
    } catch {
      return false;
    }
  }
  try {
    const startup = Date.now() + 5000;
    while (!existsSync(pidFile) && Date.now() < startup) await Bun.sleep(25);
    expect(existsSync(pidFile)).toBe(true);
    childPid = Number(readFileSync(pidFile, "utf8"));
    expect(alive()).toBe(true);
    parent.kill("SIGKILL");
    await parent.exited;
    const stopped = Date.now() + 2000;
    while (alive() && Date.now() < stopped) await Bun.sleep(25);
    const stat =
      process.platform === "linux" && childPid && existsSync(`/proc/${childPid}/stat`)
        ? readFileSync(`/proc/${childPid}/stat`, "utf8")
        : null;
    // PID 1 may not reap an exited orphan before this test container ends.
    const zombie = stat ? stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ") : false;
    expect(alive() && !zombie).toBe(false);
    // Windows force-terminates the process tree without delivering a cleanup signal.
    if (process.platform !== "win32") expect(existsSync(stoppedFile)).toBe(true);
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    if (alive() && childPid) process.kill(childPid, "SIGKILL");
    await parent.exited;
  }
}, 15000);
