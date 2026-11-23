import { execSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { instanceId, registerShutdownHook } from "@orc/api/lifecycle";
import {
  configuredApiSecret,
  dialableHost,
  globalConfigPath,
  loadConfig,
  resolveApiBase,
} from "@orc/core/config";
import {
  canonicalPath,
  clearDaemonRuntime,
  daemonHome,
  isProcessAlive,
  readDaemonRuntime,
  writeDaemonRuntime,
} from "@orc/core/daemon-runtime";
import {
  type LogLevel,
  type LogSource,
  type ReadLogsResult,
  readRecentLogs,
} from "@orc/core/logger";
import { superviseServer } from "@orc/core/process-supervisor";
import { ORC_VERSION } from "@orc/core/version";
import {
  startScheduler,
  startTaskLoop,
  startWatchers,
  stopScheduler,
  stopTaskLoop,
  stopWatchers,
} from "@orc/runner";
import { createOrcClient } from "@orc/sdk/client";
import { Command, InvalidArgumentError } from "commander";
import { inheritLoginShellPath } from "../login-path.js";
import { isJson, jsonOut } from "../output.js";
import { listAllJobs } from "./job.js";

export const ORC_HOME = daemonHome();
export const ORC_LOG = join(ORC_HOME, "daemon.log");
export const ORC_PID = join(ORC_HOME, "daemon.pid");

const TASK_NAME = "OrcDaemon";
const LAUNCHD_LABEL = "com.orc.daemon";
const LAUNCHD_PLIST = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const SYSTEMD_UNIT = join(homedir(), ".config", "systemd", "user", "orc-daemon.service");

const VOLATILE_BIN_PATHS = [
  "fnm_multishells",
  "/.nvm/versions/",
  "/.volta/tools/",
  "/.asdf/installs/",
  "nodenv/versions/",
];

function resolveOrcBin(): string {
  // Standalone binary - process.execPath IS the orc binary
  if (!process.execPath.includes("node") && !process.execPath.includes("bun")) {
    return process.execPath;
  }
  // npm global install - find `orc` on PATH
  let bin: string;
  try {
    const p = execSync(platform() === "win32" ? "where orc" : "which orc", {
      encoding: "utf-8",
    }).trim();
    bin = p.split(/\r?\n/)[0] ?? "orc";
  } catch {
    return "orc";
  }
  try {
    return realpathSync(bin);
  } catch {
    return bin;
  }
}

export function volatileBinPath(bin: string): string | null {
  const normalized = bin.replace(/\\/g, "/");
  return VOLATILE_BIN_PATHS.find((p) => normalized.includes(p)) ?? null;
}

function assertStableBin(bin: string, force: boolean): void {
  const hit = volatileBinPath(bin);
  if (!hit) return;
  const lines = [
    "",
    `  Refusing to install: the orc on PATH lives under a per-shell node path (${hit}).`,
    `    ${bin}`,
    "  That path disappears when the shell exits or the default node changes, so the",
    "  service would silently fail to start at the next login.",
    "",
    "  Fix: install the standalone release binary somewhere stable, then re-run install.",
    "  See the Install section of the README for the asset matching this machine, e.g.",
    "    curl -L https://github.com/niradler/orc/releases/latest/download/orc-mac-arm64 -o /usr/local/bin/orc",
    "    chmod +x /usr/local/bin/orc && hash -r && orc daemon install",
    "",
    "  Override (the service will break when that path goes away): orc daemon install --force",
    "",
  ];
  if (!force) {
    console.error(lines.join("\n"));
    process.exit(1);
  }
  console.warn(lines.join("\n").replace("Refusing to install:", "WARNING:"));
}

function installWindows(): void {
  const bin = resolveOrcBin();
  const cmd = `"${bin}" daemon start`;
  execSync(
    `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${TASK_NAME}" /t REG_SZ /d "${cmd}" /f`,
    { stdio: "inherit" },
  );
  console.log(`\n  Installed registry Run key "${TASK_NAME}" (runs at logon, no admin needed).`);
  console.log(
    `  View:    reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${TASK_NAME}"`,
  );
}

/**
 * launchd agent for the daemon. `SuccessfulExit: false` restarts the daemon
 * when it crashes but leaves it stopped after a clean `orc daemon stop`; plain
 * `KeepAlive: true` would start it again immediately and make stop a no-op.
 */
export function launchdPlist(bin: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bin}</string>
    <string>daemon</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${ORC_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${ORC_LOG}</string>
</dict>
</plist>`;
}

function installMacos(): void {
  const bin = resolveOrcBin();
  const plist = launchdPlist(bin);

  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(LAUNCHD_PLIST, plist);
  try {
    execSync(`launchctl unload "${LAUNCHD_PLIST}"`, { stdio: "ignore" });
  } catch {}
  execSync(`launchctl load "${LAUNCHD_PLIST}"`, { stdio: "inherit" });
  console.log(`\n  Installed launchd agent "${LAUNCHD_LABEL}" (runs at login, auto-restart).`);
  console.log(`  Plist:   ${LAUNCHD_PLIST}`);
  console.log(`  Manage:  launchctl list | grep orc`);
}

function installLinux(): void {
  const bin = resolveOrcBin();
  const unit = `[Unit]
Description=ORC Daemon - API + scheduler + channels
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${bin} daemon start
Restart=on-failure
RestartSec=5
StandardOutput=append:${ORC_LOG}
StandardError=append:${ORC_LOG}

[Install]
WantedBy=default.target
`;

  mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
  writeFileSync(SYSTEMD_UNIT, unit);
  execSync("systemctl --user daemon-reload", { stdio: "inherit" });
  execSync("systemctl --user enable --now orc-daemon.service", {
    stdio: "inherit",
  });
  console.log(`\n  Installed systemd user service "orc-daemon" (auto-start, restart on failure).`);
  console.log(`  Unit:    ${SYSTEMD_UNIT}`);
  console.log(`  Manage:  systemctl --user status orc-daemon`);
}

function uninstallWindows(): void {
  try {
    execSync(
      `reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${TASK_NAME}" /f`,
      { stdio: "inherit" },
    );
    console.log(`  Removed registry Run key "${TASK_NAME}".`);
  } catch {
    console.log(`  No registry Run key "${TASK_NAME}" found.`);
  }
}

function uninstallMacos(): void {
  if (existsSync(LAUNCHD_PLIST)) {
    try {
      execSync(`launchctl unload "${LAUNCHD_PLIST}"`, { stdio: "ignore" });
    } catch {}
    unlinkSync(LAUNCHD_PLIST);
    console.log(`  Removed launchd agent "${LAUNCHD_LABEL}".`);
  } else {
    console.log(`  No launchd plist found at ${LAUNCHD_PLIST}.`);
  }
}

function uninstallLinux(): void {
  try {
    execSync("systemctl --user disable --now orc-daemon.service", {
      stdio: "ignore",
    });
  } catch {}
  if (existsSync(SYSTEMD_UNIT)) {
    unlinkSync(SYSTEMD_UNIT);
    execSync("systemctl --user daemon-reload", { stdio: "ignore" });
    console.log(`  Removed systemd user service "orc-daemon".`);
  } else {
    console.log(`  No systemd unit found at ${SYSTEMD_UNIT}.`);
  }
}

function ensureOrcHome() {
  mkdirSync(join(ORC_HOME, "logs"), { recursive: true });
}

export function readDaemonPid(): number | null {
  try {
    return Number(readFileSync(ORC_PID, "utf-8").trim());
  } catch {
    return null;
  }
}

function writePid() {
  writeFileSync(ORC_PID, String(process.pid));
}

/**
 * Drop the pid file, but only when it still names the process being stopped: a
 * restart writes the new pid before the old process exits, and clearing the
 * file blindly would leave that daemon untrackable.
 */
function removePid(pid?: number) {
  try {
    if (pid !== undefined && readDaemonPid() !== pid) return;
    unlinkSync(ORC_PID);
  } catch {}
}

/**
 * Where the running daemon answers: the discovery record's bound port wins over
 * the configured one; a wildcard bind is reached over loopback and an IPv6 host
 * keeps the brackets its URL needs.
 */
export function daemonApiTarget(): { host: string; port: number; secret: string | undefined } {
  const runtime = readDaemonRuntime();
  const config = loadConfig();
  return {
    host: dialableHost(config.api.host),
    port: runtime?.port ?? config.api.port,
    secret: configuredApiSecret(config.api.secret),
  };
}

async function waitUntilGone(
  pid: number,
  timeoutSeconds: number,
  alive: (pid: number) => boolean,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
  while (Date.now() < deadline) {
    if (!alive(pid)) {
      removePid(pid);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!alive(pid)) {
    removePid(pid);
    return true;
  }
  return false;
}

/**
 * Ask the running daemon to drain and exit over HTTP, then wait for the pid to
 * go. This is the graceful path on every platform and launch mode (supervisor,
 * desktop app, service manager, npx); on Windows a signal is a hard kill, so it
 * is the only one there. Returns true once the process is gone.
 */
export async function requestGracefulStop(
  pid: number,
  timeoutSeconds: number,
  target = daemonApiTarget(),
  alive: (pid: number) => boolean = isProcessAlive,
): Promise<boolean> {
  try {
    const response = await fetch(`http://${target.host}:${target.port}/api/system/shutdown`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(target.secret ? { authorization: `Bearer ${target.secret}` } : {}),
      },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    if (response.status !== 202) return false;
  } catch {
    // No reachable API (already gone, or the port never bound): fall through to
    // the pid check so a finished shutdown still reports success.
  }
  return waitUntilGone(pid, timeoutSeconds, alive);
}

/** Last resort: signal the pid. The resumable chat state is already on disk. */
function signalDaemon(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    removePid(pid);
    return false;
  }
}

function parseSeconds(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new InvalidArgumentError("Pass a positive number of seconds.");
  return seconds;
}

export interface StopDaemonOptions {
  timeoutSeconds: number;
  force?: boolean;
  /** Injected in tests to exercise the Windows and POSIX branches anywhere. */
  platform?: NodeJS.Platform;
  gracefulStop?: (pid: number, timeoutSeconds: number) => Promise<boolean>;
  signal?: (pid: number, signal: NodeJS.Signals) => boolean;
  alive?: (pid: number) => boolean;
}

export type StopOutcome = { stopped: true; how: "drain" | "signal" | "kill" } | { stopped: false };

/**
 * Stop a daemon the same way on Windows, macOS and Linux: ask the API to drain,
 * then fall back to SIGTERM only where the platform delivers it to the daemon's
 * handler. Windows has no graceful signal, so a stuck drain needs `--force`.
 */
export async function stopDaemon(pid: number, options: StopDaemonOptions): Promise<StopOutcome> {
  const timeoutSeconds = Math.max(1, options.timeoutSeconds);
  const alive = options.alive ?? isProcessAlive;
  const signal = options.signal ?? signalDaemon;
  if (options.force) {
    if (!signal(pid, "SIGKILL") && !alive(pid)) return { stopped: true, how: "kill" };
    return (await waitUntilGone(pid, timeoutSeconds, alive))
      ? { stopped: true, how: "kill" }
      : { stopped: false };
  }
  const gracefulStop = options.gracefulStop ?? requestGracefulStop;
  if (await gracefulStop(pid, timeoutSeconds)) return { stopped: true, how: "drain" };
  if ((options.platform ?? platform()) === "win32") return { stopped: false };
  if (!signal(pid, "SIGTERM")) {
    return alive(pid) ? { stopped: false } : { stopped: true, how: "signal" };
  }
  return (await waitUntilGone(pid, timeoutSeconds, alive))
    ? { stopped: true, how: "signal" }
    : { stopped: false };
}

export function openDaemonLogFd(logPath: string = ORC_LOG): number {
  mkdirSync(join(ORC_HOME, "logs"), { recursive: true });
  return openSync(logPath, "a");
}

function startDetachedDaemon(): void {
  const standalone = import.meta.path.includes("$bunfs") || import.meta.path.includes("~BUN");
  const entry = process.argv[1];
  if (!standalone && !entry) {
    console.error("Could not locate the orc entry point to restart the daemon.");
    process.exitCode = 1;
    return;
  }
  const logFd = openDaemonLogFd(ORC_LOG);
  try {
    const child = spawn(
      process.execPath,
      standalone ? ["daemon"] : [...process.execArgv, entry as string, "daemon"],
      { detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true },
    );
    child.unref();
    console.log(`Daemon restarting in the background (pid ${child.pid}, log ${ORC_LOG}).`);
  } finally {
    closeSync(logFd);
  }
}

export function daemonCommand() {
  const cmd = new Command("daemon").description(
    "Run the API + scheduler + file watchers + channels as one persistent process",
  );

  cmd
    .command("start", { isDefault: true })
    .description("Start the daemon (use global --port / --host / --db / --secret to configure)")
    .action(async () => {
      if (!(await superviseServer())) return;
      ensureOrcHome();
      if (process.env.ORC_LOG_FILE === undefined) process.env.ORC_LOG_FILE = "1";
      inheritLoginShellPath();

      const existingPid = readDaemonPid();
      if (existingPid) {
        try {
          process.kill(existingPid, 0);
          console.error(`[orc] daemon already running (pid ${existingPid}). Use: orc daemon stop`);
          process.exit(1);
        } catch {
          // stale pid
        }
      }

      const config = loadConfig();

      writePid();
      registerShutdownHook(async () => {
        stopTaskLoop();
        stopScheduler();
        try {
          await stopWatchers();
        } finally {
          try {
            clearDaemonRuntime(instanceId, ORC_HOME);
          } finally {
            removePid();
          }
        }
        process.stdout.write("[orc] Stopped.\n");
      });
      await import("@orc/api");
      writeDaemonRuntime(
        {
          pid: process.pid,
          port: config.api.port,
          instance_id: instanceId,
          version: ORC_VERSION,
          db_path: config.db.path === ":memory:" ? ":memory:" : canonicalPath(config.db.path),
          config_path: canonicalPath(globalConfigPath()),
          auth_enabled: Boolean(configuredApiSecret(config.api.secret)),
          started_at: new Date().toISOString(),
          ...(process.env.ORC_DESKTOP_LAUNCH_ID
            ? { launch_id: process.env.ORC_DESKTOP_LAUNCH_ID }
            : {}),
        },
        ORC_HOME,
      );
      console.log(`[orc] home     ${ORC_HOME}`);
      console.log(`[orc] db       ${config.db.path}`);
      console.log(`[orc] API      http://${config.api.host}:${config.api.port}`);
      console.log(`[orc] pid      ${process.pid} -> ${ORC_PID}`);

      await startScheduler();
      await startWatchers();
      startTaskLoop();
      console.log("[orc] Scheduler + watchers + task loop active. Ctrl+C to stop.\n");

      await new Promise(() => {});
    });

  cmd
    .command("stop")
    .description("Stop the running daemon gracefully (active chat turns drain first)")
    .option(
      "--force",
      "Kill the daemon instead of asking it to drain; an in-flight turn is cut and resumes from the next boot",
    )
    .option(
      "--timeout <seconds>",
      "Seconds to wait for the drain before giving up",
      parseSeconds,
      30,
    )
    .action(async (opts) => {
      const daemonPid = readDaemonPid();
      if (!daemonPid) {
        console.log(`No daemon running (no pid file at ${ORC_PID}).`);
        return;
      }
      const outcome = await stopDaemon(daemonPid, {
        timeoutSeconds: opts.timeout,
        force: Boolean(opts.force),
      });
      if (!outcome.stopped) {
        console.error(
          platform() === "win32"
            ? `The daemon is still running after ${opts.timeout}s. Windows cannot deliver a graceful signal, so re-run with --force to kill it. In-flight turns resume from their last saved state.`
            : `The daemon is still running after ${opts.timeout}s. Re-run with --force to kill it; in-flight turns resume from their last saved state.`,
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        outcome.how === "kill"
          ? `Killed daemon (pid ${daemonPid}). In-flight turns resume from their saved state.`
          : outcome.how === "signal"
            ? `Daemon stopped (pid ${daemonPid}) after SIGTERM drained it.`
            : `Daemon stopped (pid ${daemonPid}).`,
      );
    });

  cmd
    .command("restart")
    .description("Stop the daemon gracefully, then start it again")
    .option("--force", "Kill instead of draining before the restart")
    .option(
      "--timeout <seconds>",
      "Seconds to wait for the drain before giving up",
      parseSeconds,
      30,
    )
    .action(async (opts) => {
      const daemonPid = readDaemonPid();
      if (daemonPid) {
        const outcome = await stopDaemon(daemonPid, {
          timeoutSeconds: opts.timeout,
          force: Boolean(opts.force),
        });
        // The replacement must not race the old process for its port.
        if (!outcome.stopped) {
          console.error(`The daemon is still running after ${opts.timeout}s; not restarting.`);
          process.exitCode = 1;
          return;
        }
      }
      startDetachedDaemon();
    });

  cmd
    .command("install")
    .description("Register orc daemon to start on login/boot and start it now")
    .option("--force", "Install even when the orc binary sits on a per-shell node path")
    .action(async (opts) => {
      ensureOrcHome();
      assertStableBin(resolveOrcBin(), Boolean(opts.force));
      const os = platform();
      console.log("[orc] Installing daemon auto-start...");
      if (os === "win32") installWindows();
      else if (os === "darwin") installMacos();
      else installLinux();
      console.log(`\n  Log:     ${ORC_LOG}`);
      console.log(`  Config:  ${globalConfigPath()}`);

      // macOS (launchctl load) and Linux (systemctl --now) already started it.
      // On Windows, use WScript.Shell Run(cmd, 0) - window style 0 = SW_HIDE.
      // This is the only reliable way to start a console process with no visible
      // window on Windows regardless of Bun/Node version.
      if (os === "win32") {
        const bin = resolveOrcBin();
        // Escape single quotes in path for PowerShell string
        const binEsc = bin.replace(/'/g, "''");
        const { execSync } = await import("node:child_process");
        execSync(
          `powershell -NonInteractive -NoProfile -WindowStyle Hidden -Command "(New-Object -ComObject WScript.Shell).Run('\\"${binEsc}\\" daemon start', 0, $false)"`,
          { windowsHide: true },
        );
        console.log(`\n  Daemon started in background (silent).`);
      }
      console.log("  Daemon will also start automatically on next login.");
    });

  cmd
    .command("uninstall")
    .description("Remove the auto-start registration created by 'orc daemon install'")
    .action(() => {
      const os = platform();
      console.log("[orc] Removing daemon auto-start...");
      if (os === "win32") uninstallWindows();
      else if (os === "darwin") uninstallMacos();
      else uninstallLinux();
    });

  cmd
    .command("status")
    .description("Show scheduler state and next run times for all active jobs")
    .action(async () => {
      const client = createOrcClient();
      const { jobs, error } = await listAllJobs(client);
      if (error) return console.error("Error:", error);

      const scheduled = jobs.filter(
        (j) => j.enabled && (j.trigger_type === "cron" || j.trigger_type === "watch"),
      );

      if (scheduled.length === 0) {
        console.log("No scheduled jobs defined.");
        console.log("Create one with: orc job add <name> --trigger cron --cron '0 22 * * *' ...");
        return;
      }

      console.log("Scheduled jobs:\n");
      for (const j of scheduled) {
        const trigger = j.trigger_type === "cron" ? `cron(${j.cron_expr ?? "?"})` : j.trigger_type;
        const lastRun = j.last_run_at
          ? new Date(j.last_run_at).toISOString().slice(0, 19)
          : "never";
        const runs = `runs:${j.run_count}`;
        const enabled = j.enabled ? "●" : "○";
        console.log(
          `  ${enabled} ${j.name.padEnd(24)} ${trigger.padEnd(24)} last:${lastRun.padEnd(20)} ${runs}`,
        );
      }
    });

  return cmd;
}

export function logsCommand() {
  return new Command("logs")
    .description("Show recent ORC daemon and worker logs")
    .option("-n, --lines <n>", "Max entries to show", "100")
    .option("-l, --level <level>", "Minimum level: debug|info|warn|error")
    .option("--ns <namespace>", "Filter by logger namespace (e.g. api:chat, runner:flow)")
    .option("-q, --query <text>", "Filter entries containing text")
    .option("--source <source>", "Log source: orc|daemon|all", "orc")
    .option("--local", "Read local log files directly without calling the API")
    .action(
      async (opts: {
        lines: string;
        level?: LogLevel;
        ns?: string;
        query?: string;
        source: LogSource;
        local?: boolean;
      }) => {
        const lines = Math.min(Math.max(Number(opts.lines) || 100, 1), 1000);
        let result: ReadLogsResult | null = null;
        if (!opts.local) {
          try {
            const config = loadConfig();
            const qs = new URLSearchParams({ lines: String(lines), source: opts.source });
            if (opts.level) qs.set("level", opts.level);
            if (opts.ns) qs.set("ns", opts.ns);
            if (opts.query) qs.set("q", opts.query);
            const headers: Record<string, string> = {};
            const secret = configuredApiSecret(process.env.ORC_API_SECRET ?? config.api.secret);
            if (secret) headers.Authorization = `Bearer ${secret}`;
            const res = await fetch(`${resolveApiBase(config)}/api/system/logs?${qs}`, {
              headers,
              signal: AbortSignal.timeout(5000),
            });
            if (res.ok) result = (await res.json()) as ReadLogsResult;
          } catch {
            // Fall back to reading local log files directly when the daemon is unreachable.
          }
        }
        result ??= readRecentLogs({
          lines,
          level: opts.level,
          ns: opts.ns,
          q: opts.query,
          source: opts.source,
        });

        if (isJson()) return jsonOut(result);
        if (!result.entries.length) {
          console.log(
            `No matching log entries in ${opts.source === "daemon" ? result.daemon_log_path : result.path}.`,
          );
          return;
        }
        for (const entry of result.entries) {
          const ts = entry.ts ? entry.ts.slice(0, 19).replace("T", " ") : "-------------------";
          const level = (entry.level ?? "log").toUpperCase().padEnd(5);
          const ns = entry.ns ? `[${entry.ns}] ` : "";
          const data = entry.data ? ` ${entry.data}` : "";
          console.log(`${ts} ${level} ${ns}${entry.msg}${data}`);
        }
      },
    );
}
